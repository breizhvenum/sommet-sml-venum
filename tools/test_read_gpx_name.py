#!/usr/bin/env python3
"""read_gpx() always gives a route a name. A GPX with no <metadata><name> came back None and
crashed the route write (found on the Peak over Bluetooth, 2026-10-27).

    python3 tools/test_read_gpx_name.py
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from regen_route import read_gpx  # noqa: E402

PTS = '<rtept lat="39.68" lon="-8.88"/><rtept lat="39.69" lon="-8.87"/>'


def gpx(body):
    f = tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False)
    f.write(f'<?xml version="1.0"?><gpx version="1.1">{body}</gpx>')
    f.close()
    return f.name


class ReadGpxName(unittest.TestCase):
    def name_of(self, body):
        path = gpx(body)
        try:
            return read_gpx(path)[0]
        finally:
            os.unlink(path)

    def test_metadata_name_wins(self):
        self.assertEqual(self.name_of(
            f"<metadata><name>Meta</name></metadata><rte><name>Own</name>{PTS}</rte>"), "Meta")

    def test_route_name_when_no_metadata(self):
        self.assertEqual(self.name_of(f"<rte><name>SommetTest</name>{PTS}</rte>"), "SommetTest")

    def test_track_name_when_no_metadata(self):
        self.assertEqual(self.name_of(f"<trk><name>Ride</name></trk><rte>{PTS}</rte>"), "Ride")

    def test_no_name_at_all(self):
        self.assertEqual(self.name_of(f"<rte>{PTS}</rte>"), "Route")


if __name__ == "__main__":
    unittest.main()
