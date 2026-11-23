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

    def test_models(self):
        catalog = self.home / "codex-usb-native-model-catalog.json"
        personal = [{"name": "claude-haiku-5-5"}, {"name": "claude-opus-personal", "displayName": "Custom"}]
        shared.save(self.profile, {"inferenceModels": personal, "otherSetting": 7})
        shared.save(catalog, {"identity": "404token-unified-api-internal",
                              "models": [{"slug": s} for s in ("gpt-6.1-terra", "claude-fable-5", "claude-opus-personal")]})
        self.config["model_catalog_json"] = str(catalog)
        for _ in range(2):
            shared.sync_models(self.home, self.profile, self.state, self.config)
        self.assertEqual(shared.read_json(self.profile)["inferenceModels"], personal + [{"name": "claude-fable-5"}])
        shared.sync_models(self.home, self.profile, self.state, {})
        self.assertEqual(shared.read_json(self.profile), {"otherSetting": 7, "inferenceModels": personal})

    @unittest.skipUnless(CLI, "bundled Code executable required")
    def test_native_code(self):
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
        sync()
        servers = shared.read_json(global_config)["mcpServers"]
        self.assertEqual(set(servers), {"media_generation", "feishu"})
        self.assertEqual(servers["feishu"]["env"]["CODEX_USB_FEISHU_SETUP_ENTRY"], str(self.base / "CodexEntryShim.exe"))
        self.check_real_servers(servers)
        defs["feishu"]["enabled"] = False
        sync()
        self.assertEqual(set(shared.read_json(global_config)["mcpServers"]), {"media_generation"})

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
            toml += [f"[mcp_servers.{name}]", 'command = "powershell.exe"', "args = " + json.dumps(spec["args"], ensure_ascii=False)]
        shared.write_file(self.home / "config.toml", "\n".join(toml).encode())
        shared.save(self.profile, {"inferenceModels": [{"name": "claude-haiku-5-5"}]})
        ps = r"""
$ErrorActionPreference = 'Stop'
$tokens=$null; $errs=$null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:QA_WORKER, [ref]$tokens, [ref]$errs)
foreach ($fn in $ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in 'PutText','SyncShared'}, $false)) {
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
        self.assertEqual((self.state / "ready-v1").read_text(), "fixture|test")
        # The official CLI opens both transports using the persisted user configuration.
        health = subprocess.run([CLI, "mcp", "list"], cwd=self.state, capture_output=True,
                                encoding="utf8", timeout=60, check=True)
        for name, server in servers.items():
            self.assertTrue(any(name in line and "Connected" in line for line in health.stdout.splitlines()), name)
            env = {k: v for k, v in os.environ.items() if not k.startswith(("MEDIA_", "FEISHU_"))}
            with subprocess.Popen([server["command"], *server["args"]], cwd=self.state,
                                  env={**env, **server.get("env", {})}, text=True, encoding="utf8",
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
