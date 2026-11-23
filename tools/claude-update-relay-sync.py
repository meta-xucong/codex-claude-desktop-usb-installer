"""Publish the Windows desktop and the precise Code archive requested by that desktop."""
import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

relay = importlib.import_module("codex-update-relay-sync")
REPO = "Wangnov/claude-app-mirror"
EXPORT = Path("/srv/codex-update-relay/export/claude")


def paired_runtime(msix):
    with zipfile.ZipFile(msix) as package:
        identity = ET.fromstring(package.read("AppxManifest.xml")).find("{*}Identity")
        if identity is None or identity.get("Name") != "Claude" or identity.get("ProcessorArchitecture") != "x64":
            raise ValueError("expected Claude Windows x64 MSIX")
        desktop = identity.attrib["Version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", desktop):
            raise ValueError("invalid package version")
        asar = package.read("app/resources/app.asar")
    return (desktop, *code_binding(asar))


def code_binding(asar):
    bindings = set()
    decoder = json.JSONDecoder()
    # Desktop embeds its verified Code manifest in multiple vendor modules.
    # Publish only when all copies that declare Windows x64 agree.
    for match in re.finditer(rb'\{"version":"[\d.]+","manifest":\{"version":"', asar):
        block, _ = decoder.raw_decode(asar[match.start():match.start()+131072].decode("utf-8", "replace"))
        manifest = block["manifest"]
        code = block["version"]
        win = manifest["platforms"]["win32-x64"]
        if (manifest["version"] != code or not re.fullmatch(r"\d+\.\d+\.\d+", code)
                or win["binary"] != "claude.exe.zst" or not re.fullmatch(r"[a-f0-9]{64}", win["checksum"])):
            raise ValueError("unsupported vendor Code manifest")
        bindings.add((code, win["checksum"], win["size"]))
    if len(bindings) != 1:
        raise ValueError("no unique vendor Code binding")
    return bindings.pop()


def publish(export, local=None):
    export.mkdir(parents=True, exist_ok=True)
    previous = relay.read_json(export/"latest.json") if (export/"latest.json").exists() else None
    if local is None:
        release = relay.github_json(f"https://api.github.com/repos/{REPO}/releases/latest")
        asset = relay.release_assets(release)["Claude-win-x64.msix"]
        if previous and "sha256:"+previous["msix"] == asset["digest"]:
            return previous
        reserve = relay.read_json(Path(relay.DEFAULT_CONFIG))["min_free_bytes"]
        if shutil.disk_usage(export).free < reserve + asset["size"]:
            raise OSError("not enough space for Claude Desktop above relay reserve")
    with tempfile.TemporaryDirectory(dir=export, prefix=".staging-") as temp:
        stage = Path(temp)
        msix = stage/"desktop.msix"
        archive = stage/"code.zst"
        if local:
            shutil.copyfile(local[0], msix)
            digest = relay.sha256_file(msix)
        else:
            relay.download_asset(asset, msix, 7200)
            digest = relay.verify_download(msix, asset)
        desktop, code, checksum, size = paired_runtime(msix)
        if local:
            shutil.copyfile(local[1], archive)
        else:
            url = f"https://downloads.claude.ai/claude-code-releases/{code}/win32-x64/claude.exe.zst"
            if shutil.disk_usage(export).free < reserve + size:
                raise OSError("not enough space for paired Code archive above relay reserve")
            with urllib.request.urlopen(url,timeout=120) as src, archive.open("wb") as dst:
                shutil.copyfileobj(src,dst)
        if archive.stat().st_size != size or relay.sha256_file(archive) != checksum:
            raise ValueError("Code archive does not match desktop's embedded manifest")
        descriptor = dict(desktop=desktop,code=code,msix=digest,archive=checksum)
        dest = export/desktop
        if previous and tuple(map(int, desktop.split("."))) < tuple(map(int, previous["desktop"].split("."))):
            raise ValueError("refusing to publish older release")
        if dest.exists():
            if relay.read_json(dest/"release.json") != descriptor:
                raise ValueError("published version is immutable")
        else:
            relay.write_json_atomic(stage/"release.json", descriptor)
            # TemporaryDirectory is private by default; nginx must read published assets.
            stage.chmod(0o755)
            os.rename(stage, dest)
        relay.write_json_atomic(export/"latest.json", descriptor)
        retain = {desktop, previous["desktop"] if previous else desktop}
        for old in export.iterdir():
            if re.fullmatch(r"\d+\.\d+\.\d+\.\d+",old.name) and old.name not in retain and not old.is_symlink():
                if set(entry.name for entry in old.iterdir()) == {"desktop.msix","code.zst","release.json"}:
                    for name in ("desktop.msix","code.zst","release.json"):
                        (old/name).unlink()
                    old.rmdir()
    return descriptor


def squirrel_resource(stream):
    """Locate the original installer's named DATA/131 PE resource."""
    def read(offset, size):
        stream.seek(offset)
        data = stream.read(size)
        if len(data) != size:
            raise ValueError("truncated installer")
        return data

    def u32(offset):
        return struct.unpack("<I", read(offset, 4))[0]

    pe = u32(0x3c)
    if read(pe, 4) != b"PE\0\0":
        raise ValueError("not a Windows installer")
    count = struct.unpack("<H", read(pe + 6, 2))[0]
    optsize = struct.unpack("<H", read(pe + 20, 2))[0]
    opt = pe + 24
    magic = struct.unpack("<H", read(opt, 2))[0]
    if magic not in (0x10b, 0x20b):
        raise ValueError("unknown Windows installer format")
    resource_rva = u32(opt + (96 if magic == 0x10b else 112) + 16)
    sections = []
    for i in range(count):
        hdr = opt + optsize + i * 40
        rva, size, raw = struct.unpack("<III", read(hdr + 12, 12))
        sections.append((rva, size, raw))

    def offset(rva, length=1):
        for addr, size, raw in sections:
            if addr <= rva and rva + length <= addr + size:
                return raw + rva - addr
        raise ValueError("resource outside PE section")

    base = offset(resource_rva)
    def child(directory, key, directory_expected):
        named, ids = struct.unpack("<HH", read(directory + 12, 4))
        for i in range(named + ids):
            name, target = struct.unpack("<II", read(directory + 16 + 8*i, 8))
            if name & 0x80000000:
                pos = base + (name & 0x7fffffff)
                length = struct.unpack("<H", read(pos, 2))[0]
                name = read(pos + 2, 2 * length).decode("utf-16-le")
            if key is not None and name != key:
                continue
            if bool(target & 0x80000000) == directory_expected:
                return base + (target & 0x7fffffff)
        raise ValueError("missing Squirrel installer resource")

    entry = child(child(child(base, "DATA", True), 131, True), None, False)
    rva, size = struct.unpack("<II", read(entry, 8))
    return offset(rva, size), size


def squirrel_code(exe, version, scratch):
    # Keep the nested archives on disk so the relay doesn't hold three copies in RAM.
    with exe.open("rb") as source, tempfile.TemporaryFile(dir=scratch) as outer:
        start, size = squirrel_resource(source)
        source.seek(start)
        while size:
            part = source.read(min(size, 1024*1024))
            if not part:
                raise ValueError("truncated Squirrel resource")
            outer.write(part)
            size -= len(part)
        with zipfile.ZipFile(outer) as dist, tempfile.TemporaryFile(dir=scratch) as inner:
            with dist.open(f"AnthropicClaude-{version}-full.nupkg") as payload:
                shutil.copyfileobj(payload, inner)
            with zipfile.ZipFile(inner) as pkg:
                return code_binding(pkg.read("lib/net45/resources/app.asar"))


def official_squirrel(version):
    src = f"https://raw.githubusercontent.com/microsoft/winget-pkgs/master/manifests/a/Anthropic/Claude/{version}/Anthropic.Claude.installer.yaml"
    with urllib.request.urlopen(src, timeout=30) as r:
        manifest = r.read(1024*1024).decode("utf-8-sig")
    entries = re.split(r"(?m)^- (?=[A-Za-z]\w*:)", manifest.split("Installers:", 1)[1])
    found = []
    for entry in entries:
        values = dict(re.findall(r"(?m)^ *(Architecture|InstallerType|InstallerUrl|InstallerSha256): *([^\s]+) *$", entry.replace("\r", "")))
        if values.get("Architecture") == "x64" and values.get("InstallerType") == "exe":
            url, digest = values["InstallerUrl"], values["InstallerSha256"].lower()
            if not re.fullmatch(r"https://downloads\.claude\.ai/releases/win32/x64/"+re.escape(version)+r"/[A-Za-z0-9.-]+\.exe",url) or not re.fullmatch(r"[a-f0-9]{64}",digest):
                raise ValueError("unexpected Claude installer distribution")
            found.append((url, digest))
    if len(found) != 1:
        raise ValueError("no unique official x64 EXE installer")
    return found[0]


def publish_squirrel(export, pair):
    channel = export/"squirrel"
    channel.mkdir(exist_ok=True)
    published = channel/"latest.json"
    previous = relay.read_json(published) if published.is_file() else {}
    desktop = pair["desktop"]
    if previous.get("desktop") == desktop and previous.get("archive") == pair["archive"] and (channel/desktop/"desktop.exe").is_file():
        return previous
    if not re.fullmatch(r"\d+\.\d+\.\d+\.0",desktop):
        raise ValueError("expected four-part desktop version")
    version = desktop.rsplit(".",1)[0]
    url, digest = official_squirrel(version)
    reserve = relay.read_json(Path(relay.DEFAULT_CONFIG))["min_free_bytes"]
    if shutil.disk_usage(channel).free < reserve + 1200*1024*1024:
        raise OSError("not enough space for Squirrel media and temporary archives")
    with tempfile.TemporaryDirectory(dir=channel,prefix=".staging-") as temp:
        stage = Path(temp)
        exe = stage/"desktop.exe"
        with urllib.request.urlopen(url,timeout=120) as src, exe.open("xb") as dst:
            shutil.copyfileobj(src,dst)
        if relay.sha256_file(exe) != digest:
            raise ValueError("official EXE digest mismatch")
        code, archive, size = squirrel_code(exe, version, stage)
        source = export/desktop/"code.zst"
        if (code,archive) != (pair["code"],pair["archive"]) or source.stat().st_size != size or relay.sha256_file(source) != archive:
            raise ValueError("EXE requests a different Code archive")
        os.link(source,stage/"code.zst")
        desc = dict(desktop=desktop,code=code,exe=digest,archive=archive)
        dest = channel/desktop
        if dest.exists():
            if relay.read_json(dest/"release.json") != desc:
                raise ValueError("published EXE version is immutable")
        else:
            relay.write_json_atomic(stage/"release.json",desc)
            stage.chmod(0o755)
            os.rename(stage,dest)
        relay.write_json_atomic(published,desc)
        for old in channel.iterdir():
            if old.name in (desktop,previous.get("desktop")) or old.is_symlink() or not re.fullmatch(r"\d+\.\d+\.\d+\.0",old.name):
                continue
            if {e.name for e in old.iterdir()} == {"release.json","desktop.exe","code.zst"}:
                for name in ("desktop.exe","code.zst","release.json"):
                    (old/name).unlink()
                old.rmdir()
        return desc


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--export",type=Path,default=EXPORT)
    parser.add_argument("--local",nargs=2,type=Path,metavar=("MSIX","CODE"))
    args = parser.parse_args()
    current = publish(args.export,args.local)
    print(json.dumps(current), flush=True)
    if args.local is None:
        print(json.dumps(publish_squirrel(args.export,current)), flush=True)
