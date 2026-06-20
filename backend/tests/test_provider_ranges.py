"""Offline tests for scripts/fetch_provider_ranges.py pure logic.

The network feeds themselves aren't exercised here (they need live HTTP); these
cover the deterministic parsing/aggregation that turns raw feed data into the
ranges the attribution engine consumes.
"""
import importlib.util
import os
import unittest

_HERE = os.path.dirname(__file__)
_SCRIPT = os.path.join(_HERE, "..", "scripts", "fetch_provider_ranges.py")
_spec = importlib.util.spec_from_file_location("fetch_provider_ranges", _SCRIPT)
frp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(frp)


class CollapseTests(unittest.TestCase):
    def test_drops_ipv6_by_default(self):
        nets = frp._collapse(["10.0.0.0/24", "2001:db8::/32"], include_ipv6=False)
        self.assertTrue(all(n.version == 4 for n in nets))

    def test_includes_ipv6_when_asked(self):
        nets = frp._collapse(["10.0.0.0/24", "2001:db8::/32"], include_ipv6=True)
        self.assertTrue(any(n.version == 6 for n in nets))

    def test_collapses_adjacent_and_dedupes(self):
        # Two adjacent /25s collapse into one /24; duplicates removed.
        nets = frp._collapse(["10.0.0.0/25", "10.0.0.128/25", "10.0.0.0/25"], include_ipv6=False)
        self.assertEqual([str(n) for n in nets], ["10.0.0.0/24"])

    def test_skips_garbage(self):
        nets = frp._collapse(["not-a-cidr", "999.0.0.0/8", "8.8.8.0/24"], include_ipv6=False)
        self.assertEqual([str(n) for n in nets], ["8.8.8.0/24"])


class GithubFeedTests(unittest.TestCase):
    def test_excludes_actions_runner_ranges(self):
        # feed_github must ignore `actions` (Azure-hosted) and keep user-facing keys.
        sample = {
            "web": ["140.82.112.0/20"],
            "api": ["140.82.112.0/20"],
            "actions": ["13.64.0.0/16", "20.1.2.0/24"],
            "domains": ["github.com"],
        }
        orig = frp._get_json
        frp._get_json = lambda url: sample
        try:
            out = frp.feed_github()
        finally:
            frp._get_json = orig
        self.assertIn("140.82.112.0/20", out)
        self.assertNotIn("13.64.0.0/16", out)
        self.assertNotIn("github.com", out)


if __name__ == "__main__":
    unittest.main()
