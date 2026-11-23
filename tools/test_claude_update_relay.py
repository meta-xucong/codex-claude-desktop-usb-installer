import hashlib
import importlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

sync = importlib.import_module("claude-update-relay-sync")


class PairedReleaseTest(unittest.TestCase):
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
