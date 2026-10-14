#!/usr/bin/env python3
"""training_program.plan_move_id: every planned move gets its own non-zero, stable id. With id 0
on every card, one finished card exercise made the watch mark the whole plan done ("Training
program completed!", André's Peak 2026-10-14). No watch, no network."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import training_program as TP

D = datetime.date


class PlanMoveId(unittest.TestCase):
    def test_never_zero_and_tagged(self):
        mid = TP.plan_move_id(D(2026, 10, 14))
        self.assertNotEqual(mid, 0)
        self.assertEqual(mid & 0xFF000000, TP.SOMMET_MOVE_ID_TAG)

    def test_day_number_is_the_watch_days_since_2000(self):
        self.assertEqual((TP.plan_move_id(D(2026, 10, 14)) >> 4) & 0xFFFFF, 9783)

    def test_stable_across_syncs(self):
        self.assertEqual(TP.plan_move_id(D(2026, 10, 17), 1), TP.plan_move_id(D(2026, 10, 17), 1))

    def test_unique_per_day_and_per_move(self):
        days = [D(2026, 10, 14) + datetime.timedelta(days=i) for i in range(60)]
        ids = {TP.plan_move_id(d, o) for d in days for o in range(3)}
        self.assertEqual(len(ids), 180)

    def test_sixteen_moves_a_day_at_most(self):
        with self.assertRaises(ValueError):
            TP.plan_move_id(D(2026, 10, 14), 16)


if __name__ == "__main__":
    unittest.main()
