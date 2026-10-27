#!/usr/bin/env python3
"""A route's distance, ascent and descent come from its GPX (2026-10-27: every route Sommet wrote
showed 0 m and 0 m climb on the watch). Checked against what Movescount and SuuntoLink wrote
when the private captures are present (assets/ is not on GitHub).

    python3 tools/test_route_totals.py
"""

import os
import re
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ambit_format as F  # noqa: E402
from build_route import route_from_gpx  # noqa: E402
from ambit_pcap import FlashImage, messages, write_packs  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent / "assets"
STAMP = (1, 1, 0, 0, 0, 0)


def gpx_file(points):
    pts = "".join(f'<rtept lat="{la}" lon="{lo}">' + (f"<ele>{e}</ele>" if e is not None else "")
                  + "</rtept>" for la, lo, e in points)
    f = tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False)
    f.write(f'<?xml version="1.0"?><gpx version="1.1"><rte><name>T</name>{pts}</rte></gpx>')
    f.close()
    return f.name


class Synthetic(unittest.TestCase):
    def build(self, points):
        path = gpx_file(points)
        try:
            return route_from_gpx(path, None, None, None, STAMP)
        finally:
            os.unlink(path)

    def test_one_degree_of_latitude(self):
        r = self.build([(45.0, 5.0, None), (46.0, 5.0, None)])
        self.assertEqual(r.distance, 111195)          # pi * 6371000 / 180
        self.assertEqual((r.ascent, r.descent), (0, 0))

    def test_climb_counts_every_rise_and_drop(self):
        r = self.build([(45.0, 5.0, 100), (45.001, 5.0, 130), (45.002, 5.0, 110),
                        (45.003, 5.0, None), (45.004, 5.0, 150)])
        self.assertEqual((r.ascent, r.descent), (70, 20))

    def test_values_given_are_kept(self):
        path = gpx_file([(45.0, 5.0, 100), (45.01, 5.0, 200)])
        try:
            r = route_from_gpx(path, 12346, 0, 0, STAMP)
        finally:
            os.unlink(path)
        self.assertEqual((r.distance, r.ascent, r.descent), (12346, 0, 0))


@unittest.skipUnless((ASSETS / "A3.Routes.and.POIs.from.MC.zip").exists(), "private captures")
class AgainstMovescount(unittest.TestCase):
    def test_lyricantrail_distance(self):
        with zipfile.ZipFile(ASSETS / "A3.Routes.and.POIs.from.MC.zip") as z:
            raw = z.read("route2892593-LyricanTrail.gpx").decode()
        pts = [(float(a), float(b)) for a, b in
               re.findall(r'<rtept lat="([-\d.]+)" lon="([-\d.]+)"', raw)]
        self.assertEqual(F.route_total_distance_m(pts), 21440)   # Movescount wrote 21440


@unittest.skipUnless((ASSETS / "ambit3 pcap" / "route128km").exists(), "private captures")
class AgainstSuuntoLink(unittest.TestCase):
    def check(self, capture, gpx, distance_slack):
        fl = FlashImage(write_packs(messages(ASSETS / "ambit3 pcap" / capture)))
        d = F.RouteDescriptor.parse(fl.read(F.ROUTE_DESC, 52))
        r = route_from_gpx(ASSETS / "ambit3 pcap" / gpx, None, None, None, STAMP)
        self.assertLessEqual(abs(r.distance - d.distance), distance_slack)
        return d, r

    def test_route128km(self):
        d, r = self.check("route128km", "Grand-Tour-HDF---Partie-1---Lille-_-Arras.gpx", 10)
        self.assertEqual(r.descent, d.descent)                     # 634, SuuntoLink's own sum

    def test_route12km_without_altitudes(self):
        d, r = self.check("route12km", "Gare-du-Nord-to-114-Av.-André-Morizet.gpx", 10)
        self.assertEqual((r.ascent, r.descent), (d.ascent, d.descent))   # 0, 0


if __name__ == "__main__":
    unittest.main()
