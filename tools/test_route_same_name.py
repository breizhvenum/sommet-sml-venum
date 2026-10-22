#!/usr/bin/env python3
"""A route sent to the watch replaces the one already there with the same name (write_nav
replace_same_name, 2026-10-22; Android RouteMerge.ts does the same). The watch ties waypoints to
routes by name, so two routes of one name would share - and on each re-send double - their pins.
Names compare as the watch stores them: 15 UTF-8 bytes. No watch, no captures."""

import io
import contextlib
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import write_nav as W  # noqa: E402


def gpx(folder, stem, name, lon):
    path = pathlib.Path(folder) / f"{stem}.gpx"
    path.write_text(
        '<?xml version="1.0"?><gpx version="1.1" creator="t" '
        'xmlns="http://www.topografix.com/GPX/1/1">'
        f"<metadata><name>{name}</name></metadata><rte>"
        f'<rtept lat="50.630" lon="{lon}"></rtept>'
        f'<rtept lat="50.635" lon="{lon + 0.005}"></rtept>'
        f'<rtept lat="50.640" lon="{lon + 0.010}"></rtept></rte></gpx>', encoding="utf-8")
    return path


def names(paths):
    with contextlib.redirect_stdout(io.StringIO()):
        routes = [W.route_from_gpx(p, 0, 0, 0, (1, 1, 0, 0, 0, 0)) for p in paths]
        return [r.name for r in W.replace_same_name(routes)]


def main():
    with tempfile.TemporaryDirectory() as d:
        old = gpx(d, "old", "Sommet plan", 3.06)
        other = gpx(d, "other", "Other route", 3.10)
        new = gpx(d, "new", "Sommet plan", 3.20)
        assert names([old, other, new]) == ["Other route", "Sommet plan"], names([old, other, new])
        assert names([old, other]) == ["Sommet plan", "Other route"]
        # the same first 15 bytes: one name on the watch
        long_old = gpx(d, "lo", "Paris-Brest-Par", 3.30)
        long_new = gpx(d, "ln", "Paris-Brest-Paris 2027", 3.40)
        assert names([long_old, long_new]) == ["Paris-Brest-Paris 2027"]
        # duplicates among the routes already on the watch are left alone
        dup = gpx(d, "dup", "Other route", 3.50)
        assert names([other, dup, new]) == ["Other route", "Other route", "Sommet plan"]
        assert W.stored_name("Entraînement côte") == "Entraînement c"
    print("ok  same-name routes are replaced, compared as stored (15 UTF-8 bytes)")


if __name__ == "__main__":
    main()
