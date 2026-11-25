"""Windows regression for joint setup. Pass the bundled claude.exe for the native checks."""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
PACK = ROOT / "installer-pack"
spec = importlib.util.spec_from_file_location("shared", ROOT / "src-tauri/src/app/claude_shared.py")
shared = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shared)
CLI = Path(sys.argv.pop(1)).resolve() if len(sys.argv) > 1 else None


class JointSetup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / "tmp")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.user = self.base / "user"
        self.claude = self.user / ".claude"
        self.home = self.base / "usb codex"
        self.kit = self.home / "codex-agent-kit"
        self.state = self.base / "manager/shared"
        self.state.mkdir(parents=True)
        self.source = self.user / ".agents/skills"
        shutil.copytree(PACK / "skills", self.source, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(PACK / "agents", self.home / "agents")
        records = [{"path": str(p), "kind": "agent"} for p in (self.home / "agents").glob("*.toml")]
        records += [{"path": str(p), "kind": "skill"} for p in self.source.rglob("*") if p.is_file()]
        shared.save(self.kit / "install-manifest.json", {
            "files": records, "skillRoot": str(self.source), "agentRoot": str(self.home / "agents")})
        shared.write_file(self.kit / "manifest/mcp-servers.json", (PACK / "manifest/mcp-servers.json").read_bytes())
        self.config = {"skills": {"config": [{"path": str(self.source / "web-search-extraction/SKILL.md"),
                                              "enabled": False}]}}
        self.profile = self.base / "profile.json"
        self.cli_env = patch.dict(os.environ, {
            "USERPROFILE": str(self.user), "HOME": str(self.user), "CLAUDE_CONFIG_DIR": str(self.claude),
            "LOCALAPPDATA": str(self.user / "local"), "APPDATA": str(self.user / "roaming"),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9", "ANTHROPIC_API_KEY": "", "ANTHROPIC_AUTH_TOKEN": "",
            "NO_PROXY": "127.0.0.1,localhost"})
        self.cli_env.start()
        self.addCleanup(self.cli_env.stop)

    def skills(self):
        shared.sync_skills(self.home, self.user, self.claude, self.state, self.config)

    def test_skill_lifecycle(self):
        custom = self.claude / "skills/feishu-doc/SKILL.md"
        shared.write_file(custom, b"personal")
        hub = self.user / ".codex/skill-hub-updater/state.json"
        shared.save(hub, {"skills": {"demo": {"files": [{"path": "SKILL.md"}]}}})
        shared.write_file(self.source / "demo/SKILL.md", b"first")
        self.skills()
        self.assertFalse((self.claude / "skills/web-search-extraction").exists())
        self.assertEqual(custom.read_bytes(), b"personal")
        self.assertEqual(len(list((self.claude / "agents").glob("usb-*.md"))), 7)
        self.assertNotIn("ALL_TOOLS", (self.claude / "skills/image-2/SKILL.md").read_text(encoding="utf8"))
        agent = self.claude / "agents/usb-content.md"
        agent.write_text("personal change", encoding="utf8")
        (self.source / "demo/SKILL.md").write_bytes(b"updated")
        self.skills()
        self.assertEqual((self.claude / "skills/demo/SKILL.md").read_bytes(), b"updated")
        shared.save(hub, {"skills": {}})
        self.skills()
        self.assertFalse(os.path.lexists(self.claude / "skills/demo"))
        self.assertEqual((self.source / "demo/SKILL.md").read_bytes(), b"updated")
        self.assertEqual(agent.read_text(), "personal change")

    def test_explicit_and_recovered_model_defaults_are_local(self):
        first = {"name": "claude-haiku-5-5", "supports1m": True}
        second = "claude-sonnet-5"
        extra = {"name": "claude-opus-4-8", "labelOverride": "My Opus"}
        codex = self.home / "config.toml"
        codex.write_text('model = "gpt-6.1-terra"')
        for initial in ({"other": 7}, {"inferenceModels": [first, second], "other": 7}):
            shared.save(self.profile, initial)
            shared.save(self.state / "models.json", [first])
            shared.manage_models(self.profile, self.state, {"operation": "default", "model": second, "directory": [first, second]})
            shared.manage_models(self.profile, self.state, {"operation": "add", "model": extra["name"], "entry": extra})
            self.assertEqual(shared.read_json(self.profile)["inferenceModels"], [second, first, extra])
            shared.manage_models(self.profile, self.state, {"operation": "reset"})
            self.assertEqual(shared.read_json(self.profile), initial)
            self.assertEqual(codex.read_text(), 'model = "gpt-6.1-terra"')

    def test_first_add_preserves_default_and_repeat_is_idempotent(self):
        initial = {"unrelated": "keep"}
        shared.save(self.profile, initial)
        native = ["sonnet", {"name": "sonnet[1m]", "supports1m": True}, "haiku"]
        request = {"operation":"add","model":"routed","entry":{"name":"routed"},"directory":native}
        shared.manage_models(self.profile,self.state,request)
        self.assertEqual(shared.read_json(self.profile)["inferenceModels"], native + [{"name":"routed"}])
        before = self.profile.read_bytes()
        shared.manage_models(self.profile,self.state,request)
        self.assertEqual(before, self.profile.read_bytes())
        shared.manage_models(self.profile,self.state,{"operation":"reset"})
        self.assertEqual(shared.read_json(self.profile), initial)

    def test_model_recovery_and_personal_edit(self):
        shared.save(self.profile, {"unrelated": "keep"})
        request = {"operation": "default", "model": "haiku-full", "directory": ["opus-full", "haiku-full"]}
        save = shared.save
        def fail_profile(path, value):
            if path == self.profile:
                raise OSError("interrupted")
            save(path, value)
        with patch.object(shared, "save", side_effect=fail_profile), self.assertRaises(OSError):
            shared.manage_models(self.profile,self.state,request)
        shared.manage_models(self.profile,self.state,request)
        current = shared.read_json(self.profile)
        self.assertFalse(current["modelDiscoveryEnabled"])
        current["inferenceModels"].append("personal")
        shared.save(self.profile,current)
        shared.manage_models(self.profile,self.state,{"operation":"reset"})
        self.assertIn("personal", shared.read_json(self.profile)["inferenceModels"])

    @unittest.skipUnless(os.name == "nt", "Windows desktop worker")
    def test_legacy_open_upgrades_once_before_launch(self):
        stamp = self.base / "ready-v1"
        trace = self.base / "calls"
        stamp.write_text("fixture|pipe")
        version = "6.28899.2.0"
        (self.base / "desktop-version").write_text(version)
        shared.save(self.base / version / "release.json", {})
        shared.save(self.base / "connection.json", {"identity": "fixture", "pipe": "pipe"})
        (self.base / "helper.ps1").touch()
        harness = r"""
$ErrorActionPreference='Stop'
$base=$env:QA_BASE; $machineRoot=$base; $action=$env:CAM_CLAUDE_ACTION
$selection=Join-Path $base 'desktop-version'; $journal=Join-Path $base 'pending'
$helper=Join-Path $base 'helper.ps1'; $record=Join-Path $base 'connection.json'
$sharedReady=Join-Path $base 'ready-v1'; $exe='fixture'; $connection=$env:QA_CREDENTIAL
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_WORKER,[ref]$null,[ref]$null)
foreach($fn in $ast.EndBlock.Statements | Where-Object Name -in 'PutText','ReadJson','SyncForDesktop'){
    . ([scriptblock]::Create($fn.Extent.Text))
}
function Get-Item { return $null }
function SelectDesktop {}
function SelectedProfileMatches { $true }
function ProfileReady { $true }
function RuntimeReady { $true }
function RestoreSeedProtocol {}
function RunningApp {}
function OtherDesktopRunning { $false }
function Note($s){[IO.File]::AppendAllText((Join-Path $base 'calls'),$s+',')}
function ConfigureDesktopProvider { Note 'profile'; if($env:QA_FAIL){throw 'fixture'} }
function SyncShared($kind){
    Note $kind
    if($env:QA_FAIL){PutText $sharedReady 'fixture|pipe|components-pending';throw 'fixture'}
    PutText $sharedReady ($env:CAM_CLAUDE_ID+'|'+$env:CAM_CLAUDE_PIPE+'|shared-v4')
}
function WaitForDesktop {Note 'open'; return 1234}
. ([scriptblock]::Create($ast.EndBlock.Statements[-1].Extent.Text))
"""
        env = {**os.environ, "QA_BASE": str(self.base), "QA_WORKER": str(ROOT / "src-tauri/src/app/claude_desktop.ps1"),
               "CAM_CLAUDE_ACTION": "open", "CAM_CLAUDE_ID": "fixture", "CAM_CLAUDE_PIPE": "pipe"}
        def run(part, fail="", action="open"):
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", harness],
                                  env={**env, "CAM_CLAUDE_ACTION": action, "CAM_CLAUDE_PREPARE_PART": part, "QA_CREDENTIAL": "placeholder", "QA_FAIL": fail},
                                  capture_output=True, timeout=20).returncode
            return 0 if result == (0x40000000 | 1234) else result
        self.assertEqual(run("desktop"), 48)
        self.assertFalse(trace.exists())
        self.assertEqual(run("upgrade-shared", "1"), 29)
        self.assertEqual(stamp.read_text(), "fixture|pipe")
        self.assertEqual(run("upgrade-shared"), 0)
        self.assertEqual(stamp.read_text(), "fixture|pipe|shared-v4")
        self.assertEqual(run("desktop"), 0)
        self.assertEqual(trace.read_text(), "profile,profile,prepare,open,open,")
        for legacy, part in (("models-v2", "prepare"), ("shared-v3", "connections")):
            stamp.write_text("fixture|pipe|" + legacy)
            self.assertEqual(run("desktop", action="status"), 15)
            self.assertEqual(run("desktop"), 48)
            self.assertEqual(run("upgrade-shared", "1"), 0)
            self.assertEqual(stamp.read_text(), "fixture|pipe|components-pending")
            self.assertEqual(run("desktop", action="status"), 15)
            self.assertEqual(run("desktop"), 0)
            self.assertTrue(trace.read_text().endswith(part + ",open,open,"))
            self.assertEqual(run("desktop", action="capabilities"), 0)
            self.assertEqual(run("desktop", action="status"), 12)

    def test_update_and_rollback_sync_tools_without_projecting_models(self):
        import venv

        runtime = self.home / "codex-agent-kit/runtime/python-env"
        venv.EnvBuilder(with_pip=False).create(runtime)
        profile = self.base / "claude-profile.json"
        shared.save(profile, {"inferenceModels": ["claude-opus-5", "claude-sonnet-5"]})
        codex = self.home / "config.toml"
        codex.write_text("model = 'gpt-6.1-terra'\n", encoding="utf8")
        snapshot = [p.read_bytes() for p in (codex, profile)]
        script = r"""
$ErrorActionPreference='Stop'
$base=$env:QA_BASE; $profilePath=Join-Path $base 'claude-profile.json'; $action='update'
$sharedReady=Join-Path $base 'ready'; $journal=Join-Path $base 'pending'
$selection=Join-Path $base 'selected'; $runtime=$base; $exe='qa'
$ast=[Management.Automation.Language.Parser]::ParseFile($env:QA_WORKER,[ref]$null,[ref]$null)
foreach ($fn in $ast.EndBlock.Statements | Where-Object Name -in 'SyncShared','SyncForDesktop','CompleteSelection','PutText'){
    . ([scriptblock]::Create($fn.Extent.Text))
}
function Show-InstallStep {}
function OtherDesktopRunning { $false }
function SelectDesktop($version) { $script:selected=$version }
function WaitForDesktop {}
function RuntimeReady { return ($script:selected -eq 'old' -or $env:QA_FAIL -eq '0') }
CompleteSelection ([pscustomobject]@{from='old';to='new'})
"""
        trace = self.base / "parts"
        # Only the packaged Python handoff is observed. Selection and SyncShared
        # above execute the production worker's upgrade and rollback logic.
        observe = "import pathlib,sys; p=pathlib.Path(sys.argv[4])/'parts'; p.open('a').write(sys.argv[1]+'\\n')"
        for fail, code, selected in [("0", 0, "new"), ("1", 35, "old")]:
            trace.unlink(missing_ok=True)
            (self.base / "pending").touch()
            env = dict(os.environ, QA_BASE=str(self.base), QA_FAIL=fail,
                       QA_WORKER=str(ROOT / "src-tauri/src/app/claude_desktop.ps1"),
                       CAM_CLAUDE_CODEX_HOME=str(self.home), CAM_CLAUDE_SHARED=observe,
                       CAM_CLAUDE_ID="fixture", CAM_CLAUDE_PIPE="fixture")
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                    env=env, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertEqual(trace.read_text().splitlines(), ["skills", "connections"])
            self.assertEqual((self.base / "selected").read_text(encoding="utf-8-sig"), selected)
            self.assertFalse((self.base / "pending").exists())
            self.assertEqual([p.read_bytes() for p in (codex, profile)], snapshot)

    @unittest.skipUnless(CLI, "bundled Code executable required")
    def test_native_code(self):
        hub_skill = self.source / "hub-demo/SKILL.md"
        shared.write_file(hub_skill, b"---\nname: hub-demo\ndescription: An offline test skill.\n---\nSay hello.")
        shared.save(self.user / ".codex/skill-hub-updater/state.json",
                    {"skills":{"hub-demo":{"files":[{"path":"SKILL.md"}]}}})
        self.skills()
        # The initialize control request lists commands and agents without sending a model prompt.
        request = {"type": "control_request", "request_id": "qa", "request": {"subtype": "initialize", "hooks": {}}}
        child = subprocess.run([CLI, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
                                "--verbose", "--no-session-persistence", "--strict-mcp-config",
                                "--mcp-config", '{"mcpServers":{}}'], input=json.dumps(request) + "\n",
                               cwd=self.state, capture_output=True, encoding="utf8", timeout=45)
        events = [json.loads(line) for line in child.stdout.splitlines() if line.startswith("{")]
        reply = next(e["response"]["response"] for e in events if e.get("type") == "control_response")
        commands = {v["name"] for v in reply["commands"]}
        expected = {d.name for d in self.source.iterdir() if (d / "SKILL.md").is_file()} - {"web-search-extraction"}
        self.assertEqual(expected - commands, set())
        self.assertNotIn("web-search-extraction", commands)
        self.assertTrue({"usb-" + p.stem for p in (PACK / "agents").glob("*.toml")} <= {v["name"] for v in reply["agents"]})

        contract = shared.read_json(PACK / "manifest/feishu-tools.json")
        shared.save(self.kit / "manifest/feishu-tools.json", contract)
        defs = {}
        for name, wrapper in (("media_generation", "start-media-generation-mcp.ps1"), ("feishu", "start-feishu-mcp.ps1")):
            args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(self.kit / "bin" / wrapper)]
            if name == "feishu":
                args += ["-PackageCache", str(self.kit / "runtime/feishu"), "-Domain", "https://open.feishu.cn", "-AuthMode", "tenant"]
            defs[name] = {"command": "powershell.exe", "args": args, "enabled": True}
        self.config["mcp_servers"] = defs
        global_config = self.claude / ".claude.json"
        def sync():
            shared.sync_servers(self.home, global_config, self.state, self.config, CLI, self.base)
        sync()
        # Upgrade a previously managed bare-name registration and execute the new
        # absolute command with Windows PowerShell absent from the child PATH.
        shell = str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe")
        self.assertEqual({s["command"] for s in shared.read_json(global_config)["mcpServers"].values()}, {shell})
        previous = shared.read_json(global_config)
        for spec in previous["mcpServers"].values():
            spec["command"] = "powershell.exe"
        shared.save(global_config, previous)
        shared.save(self.state / "servers.json", previous["mcpServers"])
        # The source still uses the old name, as did the previous manager.
        sync()
        self.assertEqual({s["command"] for s in shared.read_json(global_config)["mcpServers"].values()}, {shell})
        for spec in defs.values():
            spec["command"] = shell
        sync()
        servers = shared.read_json(global_config)["mcpServers"]
        self.assertEqual({s["command"] for s in servers.values()}, {shell})
        self.assertEqual(set(servers), {"media_generation", "feishu"})
        self.assertEqual(servers["feishu"]["env"]["CODEX_USB_FEISHU_SETUP_ENTRY"], str(self.base / "CodexEntryShim.exe"))
        self.check_real_servers(servers)
        self.assertIn("ToolSearch", (self.claude / "rules/usb-media-tools.md").read_text(encoding="utf8"))
        remote_specs = {s["id"]: s["url"] for s in shared.read_json(PACK / "manifest/mcp-servers.json")["servers"]
                        if s.get("transport") == "streamable-http"}
        self.assertEqual(set(remote_specs), {"cloudflare", "figma", "linear", "notion"})
        for name, url in remote_specs.items():
            defs[name] = {"enabled": True, "url": url}
        sync()
        registered = shared.read_json(global_config)["mcpServers"]
        for name, url in remote_specs.items():
            self.assertEqual(registered[name], {"type": "http", "url": url})
            defs[name]["enabled"] = False
        defs["media_generation"]["enabled"] = False
        defs["feishu"]["enabled"] = False
        sync()
        self.assertFalse(shared.read_json(global_config).get("mcpServers"))
        self.assertFalse((self.claude / "rules/usb-media-tools.md").exists())

    def check_real_servers(self, servers):
        for filename in ("start-media-generation-mcp.ps1", "media-generation-mcp.py",
                         "start-feishu-mcp.ps1", "feishu-tenant-server.cjs"):
            shared.write_file(self.kit / "bin" / filename, (PACK / "mcp" / filename).read_bytes())
        runtime = self.kit / "runtime"
        subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(runtime / "python-env")], check=True)
        archives = PACK / "runtime/bundled"
        with zipfile.ZipFile(archives / "node-v22.22.0-win-x64.zip") as archive:
            archive.extract("node-v22.22.0-win-x64/node.exe", runtime)
        with zipfile.ZipFile(archives / "feishu-node-modules.zip") as archive:
            archive.extractall(runtime / "feishu")
        # Exercise the production PowerShell -> bundled Python hand-off as used by joint setup.
        toml = []
        for name, spec in self.config["mcp_servers"].items():
            toml += [f"[mcp_servers.{name}]", "command = " + json.dumps(spec["command"]), "args = " + json.dumps(spec["args"], ensure_ascii=False)]
        shared.write_file(self.home / "config.toml", "\n".join(toml).encode())
        shared.save(self.profile, {"inferenceModels": [{"name": "claude-haiku-5-5"}]})
        ps = r"""
$ErrorActionPreference = 'Stop'
$tokens=$null; $errs=$null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:QA_WORKER, [ref]$tokens, [ref]$errs)
foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'PutText','Show-InstallStep','SyncShared'}, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
$runtime=$env:QA_RUNTIME; $profilePath=$env:QA_PROFILE; $base=$env:QA_BASE
$sharedReady=Join-Path $base 'shared\ready-v1'
SyncShared 'prepare'
"""
        worker_dir = ROOT / "src-tauri/src/app"
        subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], check=True,
                       capture_output=True, timeout=60, env={**os.environ,
                       "QA_WORKER": str(worker_dir / "claude_desktop.ps1"), "QA_RUNTIME": str(CLI.parent),
                       "QA_PROFILE": str(self.profile), "QA_BASE": str(self.state.parent),
                       "CAM_CLAUDE_MEDIA": str(self.base / "payload/claude"), "CAM_CLAUDE_ID": "fixture",
                       "CAM_CLAUDE_PIPE": "test", "CAM_CLAUDE_CODEX_HOME": str(self.home),
                       "CAM_CLAUDE_SHARED": (worker_dir / "claude_shared.py").read_text(encoding="utf8")})
        self.assertEqual((self.state / "ready-v1").read_text(), "fixture|test|shared-v4")
        # The official CLI opens both transports using the persisted user configuration.
        health = subprocess.run([CLI, "mcp", "list"], cwd=self.state, capture_output=True,
                                encoding="utf8", timeout=60, check=True)
        for name, server in servers.items():
            self.assertTrue(any(name in line and "Connected" in line for line in health.stdout.splitlines()), name)
            env = {k: v for k, v in os.environ.items() if not k.startswith(("MEDIA_", "FEISHU_"))}
            with subprocess.Popen([server["command"], *server["args"]], cwd=self.state,
                                  env={**env, "PATH": str(Path(os.environ["SystemRoot"]) / "System32"), **server.get("env", {})}, text=True, encoding="utf8",
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL) as proc:
                with ThreadPoolExecutor(1) as reader:
                    def message(method, params, req_id=None):
                        msg = {"jsonrpc": "2.0", "method": method, "params": params}
                        if req_id is not None:
                            msg["id"] = req_id
                        proc.stdin.write(json.dumps(msg) + "\n")
                        proc.stdin.flush()
                        if req_id is not None:
                            line = reader.submit(proc.stdout.readline).result(timeout=25)
                            return json.loads(line)["result"]
                    try:
                        message("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "offline-test", "version": "1"}}, 1)
                        message("notifications/initialized", {})
                        names = {row["name"] for row in message("tools/list", {}, 2)["tools"]}
                        if name == "feishu":
                            self.assertIn("connect", names)
                        else:
                            self.assertIn("media_capabilities", names)
                            result = message("tools/call", {"name": "media_capabilities", "arguments": {}}, 3)
                            self.assertFalse(result.get("isError", False))
                            self.assertTrue(json.loads(result["content"][0]["text"])["success"])
                    finally:
                        proc.stdin.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
