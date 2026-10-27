# Training workouts on the Ambit3 — the native platform, and what works on stock

Hardware-confirmed on an Ambit3 Peak (fw 2.4.17), 2026-10-20, cross-checked against the original
Movescount sources (the decompiled Movescount Android app, the openambit driver, the Ambit3 Peak
user guide, and a real 2020 Movescount REST capture) and the watch's own bytes. Primary-source +
on-watch truth, not inferred from older project `.md` notes. Note: 2.4.17 **is** the Movescount-era
build — the Workout Planner ran on exactly this image — so this is how Movescount itself worked.

## The platform: TWO separate planning features

Movescount had two independent planning features — different authoring tools, object types, watch
regions, and launch points. This is *why* "the Today card can't launch a complex workout" is true:
they were never the same feature.

| | Simple planned move | Complex interval / guided workout |
|---|---|---|
| Authored on | Movescount.com (web Training Programs) | Movescount phone App (workout planner) |
| Object | `sml.Plans.Plan` | guidance **Rule** (compiled to an IAMRULE app) |
| Watch region | **TrainingProgram** | **Rules / Apps** |
| Launched from | TIME-mode **"Today" card** | in-sport **WORKOUT** menu |
| Carries steps? | No — sport + duration/distance + intensity | Yes — per-step type / duration / target |
| Free run? | Card is an optional prompt (Next dismisses it); normal start stays free | Picked from the menu; normal start stays free |

Sources: Ambit3 Peak user guide §3.39 (planned moves, TIME mode) and §3.18 (interval workouts,
in-sport WORKOUT menu); `serviceadapter.xml` (Plan tree) + `WorkoutSyncer.java` (Workout → guidance
Rule) in the decompiled app; `openambit/src/libambit/device_driver_ambit3.c` (TrainingProgram vs
Rules/Apps are sibling regions); real REST round-trip in a 2020 capture.

**There is no link from a planned move to a guided workout.** The planned move's `moveId` is read by
the firmware at exactly one site (the logbook stamp, 0x2a166), never to select a workout; and the
guided chain has exactly one entrance (event 0x2FD2, posted only from the WORKOUT-menu pick handler).
Giving a move and a workout the same Plan.ID changes nothing. (Firmware re-derived from the 2.4.17
image, 2026-10-20.)

## The TrainingProgram "Today" card record (byte layout — watch-confirmed)

The region surfaces on the watch when `Sports.Plans.Source` (SBEM entry 0x2c, "Use training
program") ≠ 0; the watch re-reads it immediately after a write (no restart). Up to 60 items. Layout
read back from a real 2-item write, 2026-10-20:

```
Header (12 bytes):
  off0  u16  base year      off2 u8 month   off3 u8 day     (= the earliest item's date)
  off4  4×u8 HR-zone %       (Moderate/Hard/VeryHard/Maximal; firmware requires them strictly
                              increasing & < 101; default 60/70/80/90; used to compute the
                              in-exercise HR band)
  off8  u16  item count      off10 u16 0xFFFF

Item (40 bytes each):
  off0  u8   day offset from base date (0 = base day)    off1  u8   completed (0/1)
  off2  u16  ActivityID (3 = Run)                         off4  u32  moveId (Plan.ID; logbook only)
  off8  u32  distance (m)                                 off12 u16  duration (minutes)
  off14 u8   intensity 0-4 (Easy/Moderate/Hard/VeryHard/Maximal)   off15 u8 pad
  off16 23B  activity name (UTF-8, NUL-padded)           off39 u8   pad
```

Confirmed example (written + read back on 2026-10-20):
`ea07 0a 14 | 61 62 63 64 | 0200 | ffff` → base 2026-10-20, zones 97/98/99/100, 2 items; item 0
`day_off=0, completed=1, act=3, moveId=0x530263d0, dur=1, int=0 (Easy), "20/10 Beep5s"`. The
`completed=1` byte is the flag the watch flips at >49 % done — the "X % completed → roll to next day"
behaviour, in one byte.

## Guided (complex) workouts

A complex workout is a list of steps `{type, duration, target, text}`:
- type: warmup / interval / recovery / rest / cooldown (+ repeatStart / repeatEnd with a count)
- duration: time / distance / energy / lap / hr_below / hr_above (+ value)
- target: none / speed / pace / cadence / power / hr, with `{min, max}`

**HR targets are HR-zone values, not bpm.** `WorkoutStepValueRange` is just `{Double min, Double
max}` with no unit field; a real sample reads `hr {min: 2.0, max: 2.17}` (zone 2.0-2.17), resolved
to bpm from the athlete's zone boundaries — which is exactly what `tools/intervals_workout.py`'s
`resolve_zones_into_hr` does. Movescount uploaded the workout JSON as `<Rule><Type>guidance</Type>
<Source>`=base64 JSON, compiled it **server-side** to the IAMRULE binary, and activated it on the
watch via a `Settings.RuleIDs` list. Real RuleIDs were large numbers (e.g. 13670761), embedded in
the binary as a `rule<ID>` symbol.

## Using it today on STOCK firmware (no flashing)

- **Simple scheduled workout** ("run 30 min easy") → the native **card** does it all: target +
  duration + HR band + completion % + day-rotation. Every sport (per-activity). No flash.
- **Complex scheduled workout** → a guided workout in the **WORKOUT menu** (full steps + light +
  **melody** + "Workout ended"), optionally dated. A plain Running start stays free. No flash.
  - Add a date-gated **auto-start rule** (`tools/training_calendar.py --auto-start`) and the day's
    workout *also* auto-loads on entering the sport (steps + light) — but **silently** (no melody,
    no end screen), because the melody + end live only in the guided-menu binder (`guided=1`,
    FUN_00052a96), and the auto-start path is `guided=0`.

## The firmware patch (v4) — what it adds, and what it does NOT

v4 adds **only** the step melody + "Workout ended" screen to the auto-start / card path — the one
thing stock can't do there. It is **sport-generic** (the patched call site 0x42EAC is on the generic
rule-start path every sport's auto-start entry reaches; which sports actually get it is a data
choice — which modes carry the gated rules). It does **not** change which path runs the workout, it
does **not** affect the backlight (light already fires every step on stock), and it is **not** needed
for "free run + planned complex workout" — that combo is native via the menu. Known edge: the very
first step fires on the pre-start preview with light but no melody; every later step change gets both.

## In Sommet

- **Default (route 1):** Training Program → Sync to watch puts the dated workouts in the WORKOUT
  menu; picked by hand on the day. Cards only for plain sessions without steps.
- **"Training day on the watch" (route 2, opt-in):** adds the date-gated auto-start rules and a
  card for every entry. Saved as `trainingProgram/autoStartOptIn` since 0.2.51 (an older
  `autoStart` value is ignored). Android has route 1 only.

## No-flash recommendation
Simple → the card. Complex → the (dated) WORKOUT menu, picked by hand (full cues, free run
preserved). The patch is pure convenience: save the one manual tap, and add the melody to the no-tap
auto-start path.
