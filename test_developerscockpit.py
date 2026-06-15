import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import DevelopersCockpit as dc  # noqa: E402


class TestImportable(unittest.TestCase):
    def test_import_does_not_launch_menu(self):
        # Importing must NOT block on input() or run the menu loop.
        self.assertTrue(hasattr(dc, "main"))


class TestNextVersion(unittest.TestCase):
    def test_patch(self):
        self.assertEqual(dc.next_version("0.1.17", "patch"), "0.1.18")

    def test_minor(self):
        self.assertEqual(dc.next_version("0.1.17", "minor"), "0.2.0")

    def test_major(self):
        self.assertEqual(dc.next_version("0.1.17", "major"), "1.0.0")

    def test_bad_level(self):
        with self.assertRaises(ValueError):
            dc.next_version("0.1.17", "nope")


class TestBumpTargetSet(unittest.TestCase):
    def _seed(self, root):
        files = {
            "package.json": '{\n  "name": "root",\n  "version": "0.1.17"\n}\n',
            "ts-core/package.json": '{\n  "version": "0.1.17"\n}\n',
            "ts-markets/package.json": '{\n  "version": "0.1.17",\n  "dependencies": { "@ckir/corelib": "workspace:*" }\n}\n',
            "ts-cloud/package.json": '{\n  "version": "0.1.17"\n}\n',
            "rust/Cargo.toml": '[package]\nname = "corelib-rust"\nversion = "0.1.17"\nedition = "2021"\n',
            "README.md": "Install: download/v0.1.17/ckir-corelib-0.1.17.tgz and ckir-corelib-markets-0.1.17.tgz\n",
            # historical doc — MUST NOT be touched
            "docs/superpowers/old.md": "At the time this was version 0.1.17 (historical).\n",
        }
        for rel, content in files.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)

    def test_bumps_six_files_leaves_history(self):
        root = tempfile.mkdtemp()
        cwd = os.getcwd()
        try:
            self._seed(root)
            os.chdir(root)
            # Stub the version source so the test can't read the real workspace
            # version (defensive — get_current_version is cwd-relative, but pin it).
            _orig = dc.get_current_version
            dc.get_current_version = lambda: "0.1.17"
            try:
                old, new, changed = dc.bump_version("patch")
            finally:
                dc.get_current_version = _orig
            self.assertEqual((old, new), ("0.1.17", "0.1.18"))
            # all six targets bumped
            for rel in ["package.json", "ts-core/package.json", "ts-markets/package.json",
                        "ts-cloud/package.json", "rust/Cargo.toml", "README.md"]:
                with open(rel, encoding="utf-8") as f:
                    text = f.read()
                self.assertIn("0.1.18", text, f"{rel} not bumped")
                self.assertNotIn("0.1.17", text, f"{rel} still has old version")
            # workspace:* ref untouched
            with open("ts-markets/package.json", encoding="utf-8") as f:
                self.assertIn("workspace:*", f.read())
            # historical doc untouched
            with open("docs/superpowers/old.md", encoding="utf-8") as f:
                self.assertIn("0.1.17", f.read())
        finally:
            os.chdir(cwd)
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
