import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class TestImportable(unittest.TestCase):
    def test_import_does_not_launch_menu(self):
        # Importing must NOT block on input() or run the menu loop.
        import DevelopersCockpit  # noqa: F401
        self.assertTrue(hasattr(DevelopersCockpit, "main"))


if __name__ == "__main__":
    unittest.main()
