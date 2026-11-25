//! Only manager-launched Claude trees belong to the signed USB lease.
use std::{
    ffi::OsString,
    io,
    mem::size_of,
    os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    sync::{Arc, Mutex},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_ALREADY_EXISTS},
    System::{
        JobObjects::{
            CreateJobObjectW, IsProcessInJob, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, OpenJobObjectW, QueryInformationJobObject,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        SystemServices::JOB_OBJECT_TERMINATE,
        Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
    },
};

const WINDOW_PID: u32 = 0x4000_0000;
static SESSION: Mutex<Option<(uuid::Uuid, Arc<OwnedHandle>)>> = Mutex::new(None);
fn name(id: uuid::Uuid) -> Vec<u16> {
    format!("Local\\CodexUsbClaude-{id}\0")
        .encode_utf16()
        .collect()
}
fn create(id: uuid::Uuid) -> io::Result<OwnedHandle> {
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), name(id).as_ptr()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    if existed {
        return Err(io::Error::other(
            "Claude session job already belongs to another owner",
        ));
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            raw,
            JobObjectExtendedLimitInformation,
            (&limits as *const _ as *const std::ffi::c_void).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}
fn active(job: &OwnedHandle) -> io::Result<bool> {
    let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
    if unsafe {
        QueryInformationJobObject(
            job.as_raw_handle(),
            JobObjectBasicAccountingInformation,
            (&mut info as *mut _ as *mut std::ffi::c_void).cast(),
            size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info.ActiveProcesses > 0)
}
pub fn contains(pid: u32) -> bool {
    SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|(_, job)| owns(job, pid).unwrap_or(false))
}
pub fn keep_background() -> bool {
    SESSION
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|(_, job)| Arc::strong_count(job) > 1 || active(job).unwrap_or(true))
}
pub fn release() {
    SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();
}
pub fn stop_lease(lease: &str) {
    let Ok(id) = uuid::Uuid::parse_str(lease) else {
        return;
    };
    let raw = unsafe { OpenJobObjectW(JOB_OBJECT_TERMINATE, 0, name(id).as_ptr()) };
    if !raw.is_null() {
        let job = unsafe { OwnedHandle::from_raw_handle(raw) };
        if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
            log::error!(
                "Could not close managed Claude session: {}",
                io::Error::last_os_error()
            );
        }
    }
}
fn owns(job: &OwnedHandle, pid: u32) -> io::Result<bool> {
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return Err(io::Error::last_os_error());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(process) };
    let mut member = 0;
    if unsafe { IsProcessInJob(process.as_raw_handle(), job.as_raw_handle(), &mut member) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(member != 0)
}
pub fn launch(
    lease: uuid::Uuid,
    exe: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
) -> io::Result<u32> {
    let job = {
        let mut state = SESSION.lock().unwrap_or_else(|e| e.into_inner());
        if state.as_ref().is_none_or(|(id, _)| *id != lease) {
            *state = Some((lease, Arc::new(create(lease)?)));
        }
        state.as_ref().unwrap().1.clone()
    };
    let result = codex_win_engine::run_in_desktop_job(exe, args, env, job.as_handle())?;
    if result & 0xc000_0000 == WINDOW_PID {
        return Ok(if owns(&job, result ^ WINDOW_PID)? {
            0
        } else {
            21
        });
    }
    Ok(if result == 0 { 26 } else { result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::{
        process::Command,
        time::{Duration, Instant},
    };

    #[test]
    fn guarded_children_survive_window_close_and_only_their_lease_stops_them() {
        let id = uuid::Uuid::new_v4();
        let pid_file = std::env::temp_dir().join(format!("claude-job-{id}.pid"));
        let ps = Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        let mut personal = Command::new(ps)
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 35"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        struct Cleanup<'a>(&'a mut std::process::Child);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
                release();
            }
        }
        let personal = Cleanup(&mut personal);
        let args = ["-NoProfile", "-NonInteractive", "-Command",
            "$i=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path,'-NoProfile -Command Start-Sleep -Seconds 35');$i.UseShellExecute=$false;$i.CreateNoWindow=$true;$p=[Diagnostics.Process]::Start($i);[IO.File]::WriteAllText($env:QA_CHILD_PID,[string]$p.Id);exit (0x40000000 -bor $p.Id)"].map(OsString::from);
        assert_eq!(
            launch(
                id,
                ps,
                &args,
                &[("QA_CHILD_PID".into(), pid_file.as_os_str().into())]
            )
            .unwrap(),
            0
        );
        let child = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
        std::fs::remove_file(pid_file).unwrap();
        assert!(contains(child));
        assert!(!contains(personal.0.id()));
        assert!(keep_background());
        stop_lease(&uuid::Uuid::new_v4().to_string());
        assert!(keep_background());
        stop_lease(&id.to_string());
        let limit = Instant::now() + Duration::from_secs(5);
        while keep_background() && Instant::now() < limit {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!keep_background());
        assert!(personal.0.try_wait().unwrap().is_none());
    }
}
