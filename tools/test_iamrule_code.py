#!/usr/bin/env python3
"""Offline tests for iamrule_code.py against real compiler outputs (testdata/iamrule_oracle.json).
No watch, no network.

    ./tools/test_iamrule_code.py            # or: python3 -m unittest test_iamrule_code
"""
import json
import pathlib
import unittest

import iamrule_code as IC

FX = {k: bytes.fromhex(v) for k, v in
      json.loads((pathlib.Path(__file__).parent / "testdata" / "iamrule_oracle.json").read_text()).items()
      if not k.startswith("_")}
BEEP, LIGHT = IC.call_bytes(IC.CALL_BEEP), IC.call_bytes(IC.CALL_LIGHT)
GUIDANCE = ("guidance_2step", "guidance_3step", "guidance_2step_hr")


class Decode(unittest.TestCase):
    def test_every_fixture_decodes_and_validates(self):
        for name, binary in FX.items():
            with self.subTest(name):
                IC.validate(binary)
                self.assertTrue(IC.disassemble(binary))

    def test_guidance_template_is_step_count_independent(self):
        # a 3-step workout differs from a 2-step one only in its data table + a few count constants:
        # same code length, same instruction layout
        two, three = (IC.instructions(FX[k]) for k in ("guidance_2step", "guidance_3step"))
        self.assertEqual([(pc, op) for pc, op, _ in two], [(pc, op) for pc, op, _ in three])


class SpliceMatchesCompiler(unittest.TestCase):
    """The live compiler's own outputs for sources that differ only by the calls are the oracle."""

    def _site(self, binary, call_id):
        return IC.call_sites(binary, call_id)[0]

    def test_even_insert(self):
        pos = self._site(FX["hand_beep_light_even"], IC.CALL_BEEP)
        self.assertEqual(IC.splice(FX["hand_no_calls_even"], pos, insert=BEEP + LIGHT),
                         FX["hand_beep_light_even"])

    def test_even_delete(self):
        pos = self._site(FX["hand_beep_light_even"], IC.CALL_BEEP)
        self.assertEqual(IC.splice(FX["hand_beep_light_even"], pos, delete=14),
                         FX["hand_no_calls_even"])

    def test_odd_insert_repads(self):
        pos = self._site(FX["hand_light_odd"], IC.CALL_LIGHT)
        self.assertEqual(IC.splice(FX["hand_no_calls_odd"], pos, insert=LIGHT), FX["hand_light_odd"])

    def test_odd_delete_repads(self):
        pos = self._site(FX["hand_light_odd"], IC.CALL_LIGHT)
        self.assertEqual(IC.splice(FX["hand_light_odd"], pos, delete=7), FX["hand_no_calls_odd"])


class LightOnStepChange(unittest.TestCase):
    def test_light_follows_every_guidance_display_update(self):
        for name in GUIDANCE:
            with self.subTest(name):
                patched, n = IC.add_light_on_step_change(FX[name])
                self.assertEqual(n, 2)   # each new step + the finish screen share 2 display sites
                ins = IC.instructions(patched)
                for k, (pc, op, raw) in enumerate(ins):
                    if op == 0x21 and raw[1] == IC.CALL_GUIDANCE_DISPLAY:
                        self.assertEqual(ins[k + 1][2], LIGHT)
                self.assertEqual(len(IC.call_sites(patched, IC.CALL_LIGHT)), 2)

    def test_removing_the_lights_gives_back_the_compiler_bytes(self):
        for name in GUIDANCE:
            with self.subTest(name):
                patched, _ = IC.add_light_on_step_change(FX[name])
                for pc in sorted(IC.call_sites(patched, IC.CALL_LIGHT), reverse=True):
                    patched = IC.splice(patched, pc, delete=len(LIGHT))
                self.assertEqual(patched, FX[name])

    def test_idempotent(self):
        once, _ = IC.add_light_on_step_change(FX["guidance_2step_hr"])
        twice, n = IC.add_light_on_step_change(once)
        self.assertEqual((twice, n), (once, 0))

    def test_refuses_a_non_guidance_binary(self):
        with self.assertRaises(ValueError):
            IC.add_light_on_step_change(FX["hand_no_calls_even"])


class PerStepLights(unittest.TestCase):
    def test_condition_block_is_the_compilers_own_encoding(self):
        # the compiler's output for `if (X == 1 || X == 3 || X == 5) Suunto.light();` and
        # `if (X == 2) Suunto.light();` (X = slot 7), located by their light calls
        b = FX["hand_light_if_chain"]
        ins = IC.instructions(b)
        code = b[IC.layout(b)["code"]:]
        lights = IC.call_sites(b, IC.CALL_LIGHT)
        pcs = [pc for pc, _, _ in ins]
        chain_start = pcs[pcs.index(lights[0]) - 12]   # 3x(load,pushf,eq) + 2 or + jz
        single_start = pcs[pcs.index(lights[1]) - 4]   # load, pushf, eq, jz
        self.assertEqual(IC.light_if_step(7, [1, 3, 5], 10), code[chain_start:lights[0] + 7])
        self.assertEqual(IC.light_if_step(7, [2], 10), code[single_start:lights[1] + 7])

    def test_step_counter_counts_the_repeat_expanded_sequence(self):
        totals = {k: IC.guidance_sites(FX[k])["total"] for k in GUIDANCE + ("guidance_repeat_3x2",)}
        self.assertEqual(totals, {"guidance_2step": 2, "guidance_3step": 3,
                                  "guidance_2step_hr": 2, "guidance_repeat_3x2": 8})

    def test_light_only_on_chosen_steps(self):
        rep = FX["guidance_repeat_3x2"]
        g = IC.guidance_sites(rep)
        patched, n = IC.add_lights(rep, on_step_start=[1, 3, 5], on_finish=False, expected_total=8)
        self.assertEqual(n, 1)
        block = IC.light_if_step(g["slot"], [1, 3, 5], 8)
        code = patched[IC.layout(patched)["code"]:]
        self.assertEqual(code[g["step_start"]:g["step_start"] + len(block)], block)
        self.assertEqual(IC.splice(patched, g["step_start"], delete=len(block)), rep)

    def test_light_with_the_limits_alarm_sits_inside_the_alarm(self):
        hr = FX["guidance_2step_hr"]
        g = IC.guidance_sites(hr)
        patched, n = IC.add_lights(hr, on_step_start=[], on_limits=[0], on_finish=False)
        self.assertEqual(n, 1)
        block = IC.light_if_step(g["slot"], [0], 2)
        beep = IC.call_sites(patched, IC.CALL_BEEP)[0]
        self.assertEqual(beep, g["limits"] + len(block))   # flash right before the two beeps
        self.assertEqual(IC.splice(patched, g["limits"], delete=len(block)), hr)

    def test_step_count_mismatch_is_refused(self):
        with self.assertRaises(ValueError):
            IC.add_lights(FX["guidance_repeat_3x2"], on_step_start=[0], expected_total=4)


class TargetUnits(unittest.TestCase):
    def test_si_factors_match_the_android_port(self):
        import re
        import guided_workout as GW
        ts = (pathlib.Path(__file__).parent.parent / "android/src/services/GuidedWorkoutCore.ts").read_text()
        body = ts[ts.index("SI_FACTOR"):ts.index("};", ts.index("SI_FACTOR"))]
        android = {k: eval(v) for k, v in re.findall(r"(\w+): ([\d./ ]+),", body)}
        self.assertEqual(set(android), set(GW.SI_FACTOR))
        for k, v in GW.SI_FACTOR.items():
            self.assertAlmostEqual(android[k], v)
        body = ts[ts.index("SI_DURATION_FACTOR"):ts.index("};", ts.index("SI_DURATION_FACTOR"))]
        android_d = {k: eval(v) for k, v in re.findall(r"(\w+): ([\d./ ]+),", body)}
        self.assertEqual(set(android_d), set(GW.SI_DURATION_FACTOR))
        for k, v in GW.SI_DURATION_FACTOR.items():
            self.assertAlmostEqual(android_d[k], v)

    def test_step_ends_go_to_the_compiler_in_si(self):
        import guided_workout as GW
        wk = {"steps": [{"duration": {"durationName": n, "value": v}} for n, v in
                        (("energy", 50), ("hr_above", 150), ("hr_below", 120), ("time", 60),
                         ("distance", 1000))]}
        got = [s["duration"]["value"] for s in GW.with_si_units(wk)["steps"]]
        self.assertEqual([round(x, 4) for x in got], [209200.0, 2.5, 2.0, 60, 1000])
        self.assertEqual(wk["steps"][0]["duration"]["value"], 50)   # input untouched

    def test_intervals_pace_arrives_as_decimal_min_per_km(self):
        import intervals_workout as IW
        self.assertEqual(IW.convert_target({"_pace": {"start": 2.778, "end": 3.333}}),
                         {"targetName": "pace", "valueRange": {"min": 5.0, "max": 6.0}})


class DateGateMatchesCompiler(unittest.TestCase):
    """add_date_gate's header, symbol table, slot records and pool must be byte-identical to
    what the compiler itself emits for the same source plus the date line (2026-10-10)."""

    @staticmethod
    def _front(binary):
        import struct
        do = struct.unpack_from("<I", binary, 24)[0]
        n_slots = struct.unpack_from("<H", binary, do + 4)[0]
        rec_end = do + 6 + n_slots * 12
        pool = struct.unpack_from("<H", binary, rec_end + 2)[0]
        return binary[:rec_end + 4 + pool]

    def test_plain_and_ownvar(self):
        for a, b in (("date_gate_plain", "date_gate_plain_gated"),
                     ("date_gate_ownvar", "date_gate_ownvar_gated")):
            with self.subTest(a):
                out = IC.add_date_gate(FX[a], 9777)
                self.assertEqual(self._front(out), self._front(FX[b]))
                ins = IC.instructions(out)
                # the gate: load <days slot>, pushf 9777, eq, jz -> end; the slot is the one the
                # compiler's own code loads for the variable
                self.assertEqual([op for _, op, _ in ins[:4]], [0x14, 0x90, 0x09, 0x16])
                days_slot = int.from_bytes(ins[0][2][1:3], "little")
                compiler_loads = {int.from_bytes(raw[1:3], "little")
                                  for _, op, raw in IC.instructions(FX[b]) if op == 0x14}
                self.assertIn(days_slot, compiler_loads)
                self.assertEqual(IC.jump_target(ins[3]), [i for i in ins if i[1] == IC.END][-1][0])

    def test_refuses_twice(self):
        with self.assertRaises(ValueError):
            IC.add_date_gate(FX["date_gate_plain_gated"], 9777)

    def test_guidance_fixture_gates_and_validates(self):
        for k in GUIDANCE:
            with self.subTest(k):
                out = IC.add_date_gate(FX[k], 9778)
                IC.validate(out)
                self.assertEqual(len(IC.instructions(out)), len(IC.instructions(FX[k])) + 4)


class DateGateDays(unittest.TestCase):
    def test_reads_back_the_gated_day(self):
        for k in GUIDANCE:
            with self.subTest(k):
                self.assertEqual(IC.date_gate_days(IC.add_date_gate(FX[k], 9783)), 9783)

    def test_ungated_is_none(self):
        for k in GUIDANCE:
            with self.subTest(k):
                self.assertIsNone(IC.date_gate_days(FX[k]))


class ToleratesMissingHr(unittest.TestCase):
    """A workout with HR targets must keep running its steps with no HR (no belt, dry belt,
    dropout): HR leaves the compiler's entry check and only the zone alarm is skipped."""
    HR = "guidance_2step_hr"

    def _hr_slot(self, binary):
        return IC.builtin_slots(binary)["SUUNTO_HR"]

    def test_entry_check_no_longer_tests_hr(self):
        out, patched = IC.tolerate_missing_hr(FX[self.HR])
        self.assertTrue(patched)
        IC.validate(out)
        ins = IC.instructions(out)
        first_onerr = next(k for k, i in enumerate(ins) if i[1] == 0x12)
        slot = self._hr_slot(out)
        self.assertFalse([i for i in ins[:first_onerr]
                          if i[1] == 0x1c and int.from_bytes(i[2][1:3], "little") == slot])

    def test_every_hr_read_is_guarded_and_skips_only_the_alarm(self):
        out, _ = IC.tolerate_missing_hr(FX[self.HR])
        ins = IC.instructions(out)
        by_pc = {pc: k for k, (pc, _, _) in enumerate(ins)}
        slot = self._hr_slot(out)
        beep = IC.guidance_sites(out)["limits"]
        reads = [k for k, i in enumerate(ins)
                 if i[1] == 0x14 and int.from_bytes(i[2][1:3], "little") == slot]
        self.assertTrue(reads)
        for k in reads:
            isinv, jz, jmp = ins[k - 3], ins[k - 2], ins[k - 1]
            self.assertEqual((isinv[1], jz[1], jmp[1]), (0x1c, 0x16, 0x0d))
            self.assertEqual(IC.jump_target(jz), ins[k][0])
            skip = IC.jump_target(jmp)
            self.assertIn(skip, by_pc)
            self.assertGreater(skip, beep)   # lands after the alarm, not in the step code

    def test_idempotent_and_survives_gate(self):
        once, _ = IC.tolerate_missing_hr(FX[self.HR])
        self.assertEqual(IC.tolerate_missing_hr(once), (once, False))
        gated = IC.add_date_gate(once, 9783)
        IC.validate(gated)
        self.assertFalse(IC.tolerate_missing_hr(gated)[1])

    def test_workout_without_hr_is_unchanged(self):
        for k in ("guidance_2step", "guidance_3step"):
            with self.subTest(k):
                self.assertEqual(IC.tolerate_missing_hr(FX[k]), (FX[k], False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
