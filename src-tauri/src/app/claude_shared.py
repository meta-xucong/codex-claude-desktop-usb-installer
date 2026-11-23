"""Project the USB manager's installed capabilities into Claude Code's user scope."""
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def read_json(path, default=None):
    if not path.exists() and default is not None:
        return default
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_file(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
        tmp = Path(temp.name)
        try:
            temp.write(data)
            temp.close()
            tmp.replace(path)
        finally:
            tmp.unlink(missing_ok=True)


def save(path, value):
    write_file(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


def identifier(name):
    return bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", name))


def sync_file(target, saved, data):
    if target.resolve() != target or saved.resolve() != saved:
        return
    old = saved.read_bytes() if saved.is_file() else None
    actual = target.read_bytes() if target.is_file() else None
    if old is None and actual is not None:
        return
    if data is None:
        if actual == old and actual is not None:
            target.unlink()
        saved.unlink(missing_ok=True)
    elif old is None or actual in (old, data, None):
        if old is None:
            write_file(saved, data)
        if actual != data:
            write_file(target, data)
        if old is not None and data != old:
            write_file(saved, data)


def sync_tree(destination, snapshot, desired):
    # A snapshot exists only for files previously installed by this manager.
    # Personal folders (even ones with identical names) stay entirely user-owned.
    if destination.resolve() != destination or destination.exists() and not snapshot.is_dir():
        return
    if snapshot.resolve() != snapshot:
        raise ValueError("linked manager snapshot")
    previous = {p.relative_to(snapshot) for p in snapshot.rglob("*") if p.is_file()}
    for rel in sorted(previous | desired.keys()):
        sync_file(destination / rel, snapshot / rel, desired.get(rel))
    removed = previous - desired.keys()
    if removed:
        for root in (destination, snapshot):
            if root.is_dir():
                # Only remove empty directories from our own file paths.
                parents = {parent for rel in removed for parent in (root / rel).parents
                           if parent.is_relative_to(root)}
                for parent in sorted(parents | {root}, key=lambda p: -len(p.parts)):
                    if parent.is_dir() and parent.resolve() == parent and not any(parent.iterdir()):
                        parent.rmdir()


def sync_skills(home, user, claude, state, config):
    manifest = read_json(home / "codex-agent-kit/install-manifest.json")
    source = user / ".agents/skills"
    if Path(manifest["skillRoot"]) != source or Path(manifest["agentRoot"]) != home / "agents":
        raise ValueError("capability manifest belongs to another user")
    skills = {}
    docs = {}
    for item in manifest["files"]:
        path = Path(item["path"])
        if item["kind"] == "skill" and path.is_relative_to(source):
            rel = path.relative_to(source)
            if len(rel.parts) >= 2:
                skills.setdefault(rel.parts[0], []).append(Path(*rel.parts[1:]))
        if item["kind"] == "agent" and path.parent == home / "agents" and path.suffix == ".toml" and identifier(path.stem):
            agent = tomllib.loads(path.read_text(encoding="utf-8-sig"))
            name = "usb-" + path.stem
            description = json.dumps(agent["description"], ensure_ascii=False)
            docs[name + ".md"] = f"---\nname: {name}\ndescription: {description}\n---\n\n{agent['developer_instructions'].strip()}\n".encode()
    hub = read_json(user / ".codex/skill-hub-updater/state.json", {})
    for name, item in hub.get("skills", {}).items():
        skills[name] = [Path(f["path"]) for f in item["files"]]
    disabled = {Path(row["path"]) for row in config.get("skills", {}).get("config", [])
                if row.get("enabled") is False}
    snapshots = state / "skills"
    previous = {p.name for p in snapshots.glob("*") if p.is_dir()}
    for name in sorted(previous | skills.keys()):
        if not identifier(name):
            raise ValueError("invalid skill name")
        files = {}
        if source / name / "SKILL.md" not in disabled:
            for rel in skills.get(name, []):
                path = source / name / rel
                if rel.is_absolute() or rel.drive or ".." in rel.parts or path.resolve() != path:
                    raise ValueError("invalid installed skill path")
                data = path.read_bytes()
                if name == "image-2" and rel == Path("SKILL.md") and b"<!-- snippet: media-entry-capabilities -->" in data:
                    raw = data.decode("utf-8-sig")
                    before, rest = raw.split("## 首次发现与只读能力检查", 1)
                    _, after = rest.split("## 可用 provider", 1)
                    data = (before + "## 首次发现与只读能力检查\n\n"
                            "在 Claude Code 的 MCP 工具中查找 media_generation 的 media_capabilities，"
                            "按工具声明用空参数查询。仅询问可用性时，到此结束。\n\n## 可用 provider" + after).encode()
                files[rel] = data
        sync_tree(claude / "skills" / name, snapshots / name, files)

    snapshots = state / "agents"
    for name in {p.name for p in snapshots.glob("usb-*.md")} | docs.keys():
        sync_file(claude / "agents" / name, snapshots / name, docs.get(name))


def sync_models(home, profile, state, config):
    path = home / "codex-usb-native-model-catalog.json"
    selected = []
    if Path(config.get("model_catalog_json", "")) == path:
        catalog = read_json(path)
        if catalog.get("identity") != "404token-unified-api-internal":
            raise ValueError("unknown model catalog")
        selected = [row["slug"] for row in catalog["models"] if re.fullmatch(
            r"(?:anthropic/)?claude-(?:sonnet|opus|haiku|fable)-[a-zA-Z0-9][\w.-]*", row["slug"])]
    data = read_json(profile)
    models = data["inferenceModels"]
    receipt = state / "models.json"
    previous = read_json(receipt, [])
    # Keep the first (default) model and any entries independently edited in Claude.
    remaining = [model for i, model in enumerate(models) if i == 0 or model not in previous
                 or model.get("name") in selected]
    owned = [model for model in previous if model in remaining and model.get("name") in selected]
    names = {model["name"] if isinstance(model, dict) else model for model in remaining}
    for name in selected:
        if name not in names:
            remaining.append({"name": name})
            owned.append({"name": name})
            names.add(name)
    if len(remaining) > 200:
        raise ValueError("Claude model list is full")
    if remaining != models:
        latest = read_json(profile)
        if latest.get("inferenceModels") != models or latest.get("inferenceCredentialHelper") != data.get("inferenceCredentialHelper"):
            raise ValueError("Claude profile changed during sync")
        pending = previous + [model for model in owned if model not in previous]
        if pending != previous:
            save(receipt, pending)
        latest["inferenceModels"] = remaining
        save(profile, latest)
    if previous != owned or remaining != models:
        save(receipt, owned)


def server_definition(name, config, kit, bundle):
    entry = config.get("mcp_servers", {}).get(name)
    if not entry or not entry.get("enabled", True):
        return None
    wrapper = "start-media-generation-mcp.ps1" if name == "media_generation" else "start-feishu-mcp.ps1"
    args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(kit / "bin" / wrapper)]
    actual = entry.get("args", [])
    if (actual[:4] != args[:4] or len(actual) < 5 or Path(actual[4]) != Path(args[4])
            or entry.get("command") != "powershell.exe" or entry.get("disabled_tools") or entry.get("env")):
        raise ValueError("custom MCP registration")
    if name == "feishu":
        options = dict(zip(actual[5::2], actual[6::2], strict=True))
        domain, mode = options.get("-Domain"), options.get("-AuthMode")
        if set(options) != {"-Domain", "-AuthMode", "-PackageCache"} or Path(options["-PackageCache"]) != kit / "runtime/feishu":
            raise ValueError("custom Feishu launcher")
        if domain not in ("https://open.feishu.cn", "https://open.larksuite.com") or mode not in ("tenant", "user", "oauth"):
            raise ValueError("unrecognized Feishu connection")
        args += ["-PackageCache", str(kit / "runtime/feishu"), "-Domain", domain, "-AuthMode", mode]
        contract = read_json(kit / "manifest/feishu-tools.json")
        offered = set(contract["readTools"] + contract["writeTools"])
        if mode == "tenant":
            offered.add("connect")
        if offered - set(entry.get("enabled_tools", offered)):
            raise ValueError("custom Feishu tool restrictions")
    if name == "media_generation" and (len(actual) != 5 or "enabled_tools" in entry):
        raise ValueError("custom media tool restrictions")
    result = {"type": "stdio", "command": "powershell.exe", "args": args}
    if name == "feishu":
        result["env"] = {"CODEX_USB_FEISHU_SETUP_ENTRY": str(bundle / "CodexEntryShim.exe")}
    return result


def sync_servers(home, global_config, state, config, cli, bundle):
    receipt = state / "servers.json"
    owned = read_json(receipt, {})
    for name in ("media_generation", "feishu"):
        desired = server_definition(name, config, home / "codex-agent-kit", bundle)
        current = read_json(global_config, {}).get("mcpServers", {}).get(name)
        if current == desired:
            continue
        if current is not None and current != owned.get(name):
            if desired is not None:
                raise ValueError("personal MCP registration already uses this name")
            continue
        def run(*args):
            subprocess.run([cli, "mcp", *args, "--scope", "user"], cwd=state,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if current is not None:
            run("remove", name)
        if desired is None:
            owned.pop(name, None)
            save(receipt, owned)
        else:
            owned[name] = desired
            save(receipt, owned)
            run("add-json", name, json.dumps(desired, ensure_ascii=False))
            if read_json(global_config).get("mcpServers", {}).get(name) != desired:
                raise ValueError("Claude did not retain the MCP registration")


def main():
    mode, cli, profile, directory = sys.argv[1:]
    state = Path(directory) / "shared"
    state.mkdir(parents=True, exist_ok=True)
    home = Path(os.environ["CAM_CLAUDE_CODEX_HOME"])
    user = Path(os.environ["USERPROFILE"])
    claude = Path(os.environ.get("CLAUDE_CONFIG_DIR") or user / ".claude")
    config = tomllib.loads((home / "config.toml").read_text(encoding="utf-8-sig"))
    if mode in ("all", "skills"):
        sync_skills(home, user, claude, state, config)
    if mode in ("all", "models"):
        sync_models(home, Path(profile), state, config)
    if mode in ("all", "connections"):
        global_config = claude / ".claude.json" if os.environ.get("CLAUDE_CONFIG_DIR") else user / ".claude.json"
        sync_servers(home, global_config, state, config, cli, Path(os.environ["CAM_CLAUDE_MEDIA"]).parent.parent)


if __name__ == "__main__":
    main()
