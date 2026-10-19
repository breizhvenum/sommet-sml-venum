#!/usr/bin/env python3
"""Android's Ambit3 route send keeps the routes already on the watch (routes/05), without a watch.

Ground truth: the route128km SuuntoLink capture (assets/ambit3 pcap/, git-ignored - skipped where
it is absent): two routes with their waypoints, as SuuntoLink wrote them. The desktop keeps
existing routes by reading each one back (write_nav.route_to_gpx) and rebuilding it
(build_route.route_from_gpx). Android does the same in TypeScript (RouteReader.decodeNavigation
+ RouteMerge.mergeRoutes). This hands both regions of the capture to the Android code (jest,
RouteMerge.test.ts) with what the desktop gets from the same bytes: every route must come back
with the same points and the same waypoints, tied to the same route points.
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile

import ambit_format as F
import write_nav
from ambit_pcap import FlashImage
from build_route import route_from_gpx

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPTURE = ROOT / "assets" / "ambit3 pcap" / "route128km"
ANDROID = ROOT / "android"


def desktop_view(flash):
    header = F.RouteHeader.parse(flash.read(F.ROUTE_BASE, 32))
    routes = []
    for i in range(header.route_count):
        d = F.RouteDescriptor.parse(flash.read(F.ROUTE_DESC + 52 * i, 52))
        with tempfile.NamedTemporaryFile("w", suffix=".gpx", delete=False) as f:
            f.write(write_nav.route_to_gpx(flash, i))
        try:
            r = route_from_gpx(pathlib.Path(f.name), d.distance, d.ascent, d.descent, (1, 1, 0, 0, 0, 0))
        finally:
            os.unlink(f.name)
        routes.append({"name": d.name, "points": len(r.points),
                       "waypoints": [[name, idx] for _lat, _lon, name, idx in r.waypoints]})
    return routes


def main():
    if not CAPTURE.exists():
        print("route merge: capture absent, skipped")
        return 0
    if not (ANDROID / "node_modules").is_dir():
        print("route merge: android/node_modules missing, skipped")
        return 0
    flash = FlashImage.from_pcap(CAPTURE)
    fixture = {
        "waypoints": base64.b64encode(flash.read(F.WAYPOINT_BASE, 16384)).decode(),
        "routes": base64.b64encode(flash.read(F.ROUTE_BASE, 130000)).decode(),
        "desktop": desktop_view(flash),
    }
    assert len(fixture["desktop"]) == 2, fixture["desktop"]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(fixture, f)
    try:
        env = dict(os.environ, ROUTE_MERGE_FIXTURE=f.name)
        proc = subprocess.run(["npx", "jest", "--silent", "src/services/__tests__/RouteMerge.test.ts"],
                              cwd=ANDROID, env=env, capture_output=True, text=True)
    finally:
        os.unlink(f.name)
    if proc.returncode != 0:
        print(proc.stdout[-3000:], proc.stderr[-3000:])
        return 1
    print("route merge: Android keeps the capture's 2 routes exactly as the desktop does")
    return 0


if __name__ == "__main__":
    sys.exit(main())
