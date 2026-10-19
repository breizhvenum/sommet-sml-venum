#!/usr/bin/env python3
"""Wahoo route send warns past 200 km without turn cues (routes/06), without an ELEMNT.

Wahoo's routing page: turn-by-turn is limited to 200 km for a route file without embedded cues.
"""
import os
import sys
import tempfile

import wahoo_routes as W


def _write(ext, body):
    f = tempfile.NamedTemporaryFile("w", suffix=ext, delete=False)
    f.write(body)
    f.close()
    return f.name


def _gpx(km, wpt=False, lon_first=False):
    n = int(km) + 1                       # one point per ~1 km going north (0.009 deg ~ 1 km)
    pts = "".join((f'<trkpt lon="2.0" lat="{48 + 0.009 * i:.6f}"/>' if lon_first else
                   f'<trkpt lat="{48 + 0.009 * i:.6f}" lon="2.0"/>') for i in range(n))
    w = '<wpt lat="48" lon="2"><name>Left</name></wpt>' if wpt else ""
    return f'<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">{w}<trk><trkseg>{pts}</trkseg></trk></gpx>'


def main():
    paths = []
    try:
        long_gpx = _write(".gpx", _gpx(250)); paths.append(long_gpx)
        note = W.turn_by_turn_note(long_gpx)
        assert note and note.startswith("250 km") and "200 km" in note, note
        paths.append(_write(".gpx", _gpx(250, lon_first=True)))
        assert W.turn_by_turn_note(paths[-1]), "lon before lat"
        paths.append(_write(".gpx", _gpx(150)))
        assert W.turn_by_turn_note(paths[-1]) is None, "short route"
        paths.append(_write(".gpx", _gpx(250, wpt=True)))
        assert W.turn_by_turn_note(paths[-1]) is None, "route with cues"
        tcx = "".join(f"<Trackpoint><Position><LatitudeDegrees>{48 + 0.009 * i:.6f}</LatitudeDegrees>"
                      f"<LongitudeDegrees>2.0</LongitudeDegrees></Position></Trackpoint>" for i in range(251))
        paths.append(_write(".tcx", f"<TrainingCenterDatabase><Courses><Course><Track>{tcx}</Track></Course></Courses></TrainingCenterDatabase>"))
        assert W.turn_by_turn_note(paths[-1]), "long TCX"
        paths.append(_write(".fit", "not read"))
        assert W.turn_by_turn_note(paths[-1]) is None
    finally:
        for p in paths:
            os.unlink(p)
    print("wahoo route note: warns past 200 km without cues")
    return 0


if __name__ == "__main__":
    sys.exit(main())
