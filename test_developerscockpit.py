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
            # Cargo.lock: the corelib-rust entry must bump; the sibling dep at the same
            # version must NOT (proves the bump targets only the corelib-rust block).
            "rust/Cargo.lock": '[[package]]\nname = "corelib-rust"\nversion = "0.1.17"\ndependencies = []\n\n[[package]]\nname = "look-alike-dep"\nversion = "0.1.17"\n',
            "README.md": "Install: download/v0.1.17/ckir-corelib-0.1.17.tgz and ckir-corelib-markets-0.1.17.tgz\n",
            # historical doc — MUST NOT be touched
            "docs/superpowers/old.md": "At the time this was version 0.1.17 (historical).\n",
        }
        for rel, content in files.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p) or ".", exist_ok=True)
            with open(p, "w", encoding="utf-8") as f:
                f.write(content)

    def test_bumps_target_files_leaves_history(self):
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
            # Cargo.lock: only the corelib-rust entry bumps; the sibling at the same
            # version is left untouched (targeted, not a blanket replace).
            with open("rust/Cargo.lock", encoding="utf-8") as f:
                lock = f.read()
            self.assertIn('name = "corelib-rust"\nversion = "0.1.18"', lock)
            self.assertIn('name = "look-alike-dep"\nversion = "0.1.17"', lock)
            # workspace:* ref untouched
            with open("ts-markets/package.json", encoding="utf-8") as f:
                self.assertIn("workspace:*", f.read())
            # historical doc untouched
            with open("docs/superpowers/old.md", encoding="utf-8") as f:
                self.assertIn("0.1.17", f.read())
        finally:
            os.chdir(cwd)
            shutil.rmtree(root, ignore_errors=True)


class TestReleaseCmd(unittest.TestCase):
    def test_no_python_list_repr(self):
        cmd = dc.make_release_cmd()
        if cmd is not None:
            self.assertNotIn("['", cmd, "release cmd leaked a Python list repr")
            self.assertNotIn("']", cmd)

    def test_platform_shape(self):
        cmd = dc.make_release_cmd()
        if cmd is not None:
            if dc.IS_WINDOWS:
                self.assertIn("Compress-Archive", cmd)
                self.assertTrue(cmd.startswith("pwsh "), "must invoke pwsh, not bare cmdlet")
            else:
                self.assertIn("tar -czf", cmd)


class TestActionsIntegrity(unittest.TestCase):
    def test_keys_unique_upper_single(self):
        keys = [a.key for a in dc.ACTIONS]
        self.assertEqual(len(keys), len(set(keys)), "duplicate keys")
        self.assertTrue(all(len(k) == 1 and k.isupper() for k in keys))

    def test_exactly_one_of_cmd_or_handler(self):
        for a in dc.ACTIONS:
            self.assertTrue(
                bool(a.cmd) ^ bool(a.handler),
                f"action {a.key} must have exactly one of cmd/handler",
            )

    def test_group_is_a_known_tier(self):
        for a in dc.ACTIONS:
            self.assertIn(a.group, dc.TIERS)

    def test_pnpm_run_convention(self):
        for a in dc.ACTIONS:
            if a.cmd and a.cmd.startswith("pnpm ") and not a.cmd.startswith("pnpm exec"):
                self.assertTrue(a.cmd.startswith("pnpm run "), f"{a.key}: {a.cmd!r}")

    def test_rust_tests_single_threaded(self):
        u = next(a for a in dc.ACTIONS if a.key == "U")
        self.assertIn("--test-threads=1", u.cmd)

    def test_has_new_workflow_items(self):
        keys = {a.key for a in dc.ACTIONS}
        self.assertTrue({"Y", "N", "I", "J"}.issubset(keys))
        self.assertNotIn("M", keys)


if __name__ == "__main__":
    unittest.main()
