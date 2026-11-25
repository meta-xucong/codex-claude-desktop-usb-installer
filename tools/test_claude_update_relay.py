import hashlib
import importlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sync = importlib.import_module("claude-update-relay-sync")


class PairedReleaseTest(unittest.TestCase):
    def test_exe_channel_keeps_last_pair_when_new_code_does_not_match(self):
        with tempfile.TemporaryDirectory() as temp:
            export = Path(temp)
            config = export/"config.json"
            config.write_text('{"min_free_bytes": 0}')
            exe, code = b"fixture desktop", b"fixture runtime"
            digest = hashlib.sha256(exe).hexdigest()
            archive = hashlib.sha256(code).hexdigest()
            def download(*args, **kwargs):
                stream = io.BytesIO(exe)
                stream.headers = {"Content-Length": str(len(exe))}
                return stream
            def release(version):
                folder = export/version
                folder.mkdir()
                (folder/"code.zst").write_bytes(code)
                return dict(desktop=version, code="2.1.328", archive=archive)
            with patch.object(sync.relay, "DEFAULT_CONFIG", config), \
                 patch.object(sync, "official_squirrel", return_value=("fixture",digest)), \
                 patch.object(sync.urllib.request, "urlopen", side_effect=download), \
                 patch.object(sync, "squirrel_code", return_value=("2.1.328",archive,len(code))) as pairing:
                previous = sync.publish_squirrel(export, release("6.28899.2.0"))
                next_pair = release("6.28899.6.0")
                pairing.return_value = ("2.1.330",archive,len(code))
                with self.assertRaises(ValueError):
                    sync.publish_squirrel(export,next_pair)
                channel = export/"squirrel"
                self.assertEqual(json.loads((channel/"latest.json").read_text()),previous)
                self.assertFalse((channel/next_pair["desktop"]).exists())
                self.assertEqual((channel/previous["desktop"]/"code.zst").read_bytes(),code)

    def test_incomplete_new_pair_keeps_previous_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            export = root/"export"
            archive = root/"code.zst"
            archive.write_bytes(b"fixture code")

            def fixture(version, code):
                msix = root/(version+".msix")
                payload = archive.read_bytes()
                binding = {"binary":"claude.exe.zst","size":len(payload),"checksum":hashlib.sha256(payload).hexdigest()}
                manifest = {"version":code,"manifest":{"version":code,"platforms":{"win32-x64":binding}}}
                with zipfile.ZipFile(msix,"w") as pkg:
                    pkg.writestr("AppxManifest.xml",f'<Package><Identity Name="Claude" Version="{version}" ProcessorArchitecture="x64"/></Package>')
                    pkg.writestr("app/resources/app.asar",json.dumps(manifest,separators=(",",":")))
                return msix

            old = sync.publish(export,(fixture("1.0.0.0","2.1.1"),archive))
            new = fixture("2.0.0.0","2.1.2")
            wrong = root/"other.zst"
            wrong.write_bytes(b"wrong")
            with self.assertRaises(ValueError):
                sync.publish(export,(new,wrong))
            self.assertEqual(json.loads((export/"latest.json").read_text()),old)
            self.assertFalse((export/"2.0.0.0").exists())
            new_release = sync.publish(export,(new,archive))
            self.assertEqual(new_release["code"],"2.1.2")
            self.assertTrue((export/old["desktop"]/"desktop.msix").is_file())
            self.assertEqual(sync.publish(export,(new,archive)),new_release)


if __name__ == "__main__":
    unittest.main()
