import unittest
from sync_build import update_url

class TestSyncBuild(unittest.TestCase):
    def test_update_url_adds_v(self):
        self.assertEqual(update_url("style.css", "b99"), "style.css?v=b99")

    def test_update_url_replaces_v(self):
        self.assertEqual(update_url("style.css?v=b10", "b99"), "style.css?v=b99")

    def test_update_url_preserves_other_params(self):
        self.assertEqual(update_url("style.css?foo=bar", "b99"), "style.css?v=b99&foo=bar")
        self.assertEqual(update_url("style.css?v=b10&foo=bar", "b99"), "style.css?v=b99&foo=bar")

if __name__ == '__main__':
    unittest.main()
