#!/usr/bin/env python3
"""Indoor moves keep their sport in the FIT that goes to intervals.icu / Strava.

Forum report 2026-09-23: an Ambit indoor ride reached intervals.icu as "strength training".
Most watch moves have an empty name, so only the activity-id byte carries the sport; without a
mapping the FIT said "generic" and intervals.icu filed it as strength. The mapping lives three
times - here (desktop), jni_bridge.cpp (Android) and AmbitUsbModule.mm (iOS) - so this also checks
that the three tables are the same.

    python3 tools/test_indoor_fit_sport.py
"""
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import exercise_log as E
import fit_decode

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NATIVE = {
    "android": os.path.join(ROOT, "android/android/app/src/main/cpp/jni_bridge.cpp"),
    "ios": os.path.join(ROOT, "android/ios/AmbitBle/AmbitUsbModule.mm"),
}


def header(activity_type, name=""):
    return {"year": 2026, "month": 9, "day": 23, "hour": 18, "minute": 0, "msec": 0,
            "duration_ms": 600_000, "distance": 5000, "ascent": 0, "descent": 0,
            "activity_type": activity_type, "activity_name": name,
            "heartrate_avg": 130, "heartrate_max": 160}


def periodic(ms, hr, power):
    return {"type": "periodic", "time": ms,
            "values": [{"type": 6, "name": "time", "value": ms},
                       {"type": 1, "name": "hr", "value": hr},
                       {"type": 0, "name": "bikepower", "value": power}]}


def native_table(path):
    """The suunto_id_to_fit_sport switch of a native twin -> {id: (sport, sub_sport)}."""
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    body = src[src.index("static uint8_t suunto_id_to_fit_sport"):]
    body = body[:body.index("default:")]
    table = {}
    for labels, stmt in re.findall(r"((?:case\s+\d+:\s*)+)([^\n]*?break;)", body):
        sp = re.search(r"sp\s*=\s*(\d+)", stmt)
        ss = re.search(r"ss\s*=\s*(\d+)", stmt)
        for i in re.findall(r"case\s+(\d+):", labels):
            table[int(i)] = (int(sp.group(1)), int(ss.group(1)) if ss else 0)
    return table


class IndoorFitSport(unittest.TestCase):
    def test_indoor_ids_map_to_their_sport(self):
        self.assertEqual(E._fit_sport(header(17)), (2, 58))   # indoor cycling -> Virtual Ride
        self.assertEqual(E._fit_sport(header(93)), (1, 1))    # treadmill
        self.assertEqual(E._fit_sport(header(71)), (15, 14))  # indoor rowing
        self.assertEqual(E._fit_sport(header(23)), (4, 20))   # weight training (real strength)

    def test_indoor_ride_fit_is_a_virtual_ride_not_strength(self):
        samples = [periodic(t * 1000, 120 + t, 180 + t) for t in range(0, 600, 10)]
        data = E.to_fit(header(17), samples)
        with tempfile.NamedTemporaryFile(suffix=".fit", delete=False) as fh:
            fh.write(data)
        try:
            summary = fit_decode.decode(fh.name)
        finally:
            os.unlink(fh.name)
        self.assertNotIn("strength", str(summary.get("sport", "")).lower())
        self.assertIn("cycling", str(summary.get("sport", "")).lower())

    def test_native_twins_match_the_desktop(self):
        for name, path in NATIVE.items():
            with self.subTest(name):
                self.assertEqual(native_table(path), E._SUUNTO_ID_TO_FIT)


if __name__ == "__main__":
    unittest.main()
