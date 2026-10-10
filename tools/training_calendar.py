#!/usr/bin/env python3
"""Calendar of dated native guided workouts, named "dd/mm_name" in the WORKOUT menu — the
locked design (André, 2026-08-21) for the "Today"/planned-training experience, taken instead
of the unreachable native `TrainingProgram` flash region (see
`assets/Firmware/re-out/training_program_CONCLUSION.md`).

Flow: pick a date -> pick an activity -> build a workout (tools/workout.py schema) -> this
tool compiles it through the real native guidance path (guided_workout.py's compile_workout,
the JSON->Komposti-binary breakthrough, hardware-confirmed 2026-08-19/20) and installs it into
the browsable WORKOUT menu, named "dd/mm_<workout name>" so the rider can tell entries apart
and pick the right one by hand. Without --auto-start there is NO on-watch date logic involved —
the date is just a label a human reads, sidestepping the firmware wall entirely rather than
working around it with an App-Zone countdown app (training_plan.py's older design, superseded
for this feature by André's explicit call).

With --auto-start (2026-10-10) the date logic is back on the watch, but inside the NATIVE
stepped workout: each compiled workout gets `if (SUUNTO_DAYS_AFTER_1_1_2000 == its day)` in
front of its code (iamrule_code.add_date_gate, a byte-exact copy of what the compiler emits
for that line) and every installed workout is an active rule of the sport's workout mode at
once. The watch's own clock runs the day's one; the others do nothing. No computer needed on
the day - the sync only keeps the five slots filled as weeks pass.

Rotation, per André ("on the sync we erase the ones past #today and put another ones"): each
--sync erases every managed (dd/mm_-prefixed) entry whose date has passed and installs
whatever's next from the plan that isn't already installed. Managed entries are recognized by
the "dd/mm_" name prefix this tool writes; anything else already on the watch (a manually
installed guided workout, a generic Suunto App) is left alone.

Known v1 simplification: the watch only stores "dd/mm" in the app name, no year. Expiry is
therefore judged by comparing (month, day) against today's (month, day) — correct for the
intended use (planning days/weeks/months ahead within one calendar year), but will misjudge an
entry planned to survive a Dec->Jan year boundary. Not worth solving until it's a real need.

Plan JSON (dates are ISO YYYY-MM-DD; `workout` is workout.py's own schema unchanged):

    {
      "name": "Marathon prep",
      "entries": [
        {"date": "2026-08-25", "mode": "Running", "workout": {"name": "Long run", "steps": [...]}},
        {"date": "2026-08-28", "mode": "Running", "workout": {"name": "5x3min intervals", ...}}
      ]
    }

    ./tools/training_calendar.py PLAN.json --sync                 # dry-run, shows the diff
    ./tools/training_calendar.py PLAN.json --sync --write         # actually erase + install
    ./tools/training_calendar.py PLAN.json --sync --today 2026-08-27 --write   # override "today"
    ./tools/training_calendar.py --list                           # show what's on the watch now
    ./tools/training_calendar.py --remove "Light workout" --write # drop one manual native workout
"""
import argparse
import datetime
import json
import re
import struct
import sys
import time

import apps
import custom_modes as cm
import custom_modes_write as cmw
import guided_workout as GW
import iamrule_code as IC
import training_plan as TP
import workout_install as WI
from ambit_pcap import FlashImage
from write_nav import CMD_DEVICE_INFO, Link, read_flash, read_memory_map, send_plan

MANAGED_RE = re.compile(r"^(\d{2})/(\d{2})_")
# The sport mode(s) the plan's workouts run in with auto-start: the ones of that sport whose
# name says so ("Running workout"). The watch-face card's Start opens the sport list, so the
# list IS the choice: pick "Running workout" and the day's steps run, pick "Running" and it is a
# free run (André, 2026-10-10: "I want to be able to select from here. not automatically when
# running"). Every mode of the sport ran the plan before that (2026-10-05) - a free run was not
# possible without END WORKOUT.
WORKOUT_MODE_RE = re.compile(r"workout|plan", re.IGNORECASE)
DATE_GATE_MARK = b"SUUNTO_DAYS_AFTER_1_1_2000\0"


def is_gated(binary):
    """True if a compiled workout reads the watch's date (iamrule_code.add_date_gate)."""
    return DATE_GATE_MARK in bytes(binary)


def gated_binary(binary, date_iso):
    """The magic-less compiled workout, run only on `date_iso` by the watch's own clock
    (iamrule_code.add_date_gate; the day value is training_plan.date_to_days2000's, hardware-
    verified on the Sport 2026-09-02)."""
    b = bytes(binary)
    if b[:len(apps.MAGIC)] == apps.MAGIC:
        b = b[len(apps.MAGIC):]
    return IC.add_date_gate(apps.MAGIC + b, TP.date_to_days2000(date_iso))[len(apps.MAGIC):]


def native_block(raw_block, binary):
    """An Apps entry block (header + name + magic + binary) for the same name with a new
    binary: any-mode sport byte, fresh marker."""
    return (bytes([GW.GUIDANCE_ENTRY_TYPE, GW.ANY_MODE_ACTIVITY, apps.entry_checksum(binary)])
            + raw_block[3:3 + apps.NAME_LEN] + apps.MAGIC + binary)


def gate_managed(entries, dates_by_label):
    """(entries, gated_names): every managed native entry that does not yet read the date gets
    its block rebuilt with the gate for its plan date. Entries whose label is not in
    `dates_by_label` are left alone."""
    out, names = [], []
    for e in entries:
        e = dict(e)
        if (is_managed(e["name"]) and e.get("reserved") == GW.GUIDANCE_ENTRY_TYPE
                and e["name"] in dates_by_label and not is_gated(e["binary"])):
            binary = gated_binary(e["binary"], dates_by_label[e["name"]])
            e["_raw_block"] = native_block(e["_raw_block"], binary)
            e["binary"] = binary
            names.append(e["name"])
        out.append(e)
    return out, names


def entry_label(date_iso, workout_name):
    """"dd/mm_name", truncated to fit the 29-byte on-watch name field (apps.NAME_LEN)."""
    d = datetime.date.fromisoformat(date_iso)
    prefix = f"{d.day:02d}/{d.month:02d}_"
    budget = (apps.NAME_LEN - 1) - len(prefix)
    return prefix + workout_name[:max(budget, 0)]


def is_managed(name):
    return bool(MANAGED_RE.match(name or ""))


def is_expired(name, today):
    """True if a managed "dd/mm_..." name's (month, day) is before today's — see the module
    docstring's "known v1 simplification" on why this ignores year."""
    m = MANAGED_RE.match(name or "")
    if not m:
        return False
    day, month = int(m.group(1)), int(m.group(2))
    return (month, day) < (today.month, today.day)


def rebuild_apps_region(raw_blocks):
    """Same directory-format assembly as workout_install.build_apps_region's tail, for the
    pure-removal case (no new entry to hand it) — see that function's docstring for the format."""
    num_entries = len(raw_blocks)
    table_len = 4 + 4 * (num_entries + 1)
    offsets = []
    cursor = table_len
    for b in raw_blocks:
        offsets.append(cursor)
        cursor += len(b)
    total_length = cursor
    header = struct.pack("<HH", num_entries, num_entries ^ 0x02) + struct.pack(
        f"<{num_entries + 1}I", *offsets, total_length)
    return header + b"".join(raw_blocks)


def plan_diff(current_apps_bytes, plan_entries, today, menu_max=GW.WORKOUT_MENU_MAX):
    """Returns (kept_raw_blocks, to_add, waiting).

    The WORKOUT menu shows only the first `menu_max` native workouts, so the calendar syncs to
    the space available (André, 2026-09-26): the manually installed native workouts keep their
    slots, and the soonest upcoming plan entries fill the rest - earliest first. `waiting` is the
    labels of the later ones; as past ones are erased, each sync moves the next ones in.

    A managed entry is kept only if it's in that window - so an expired one, one removed from
    the calendar (TrainingProgramPage.qml's "Remove workout"), and one pushed out of the window
    are all erased. Unmanaged entries (anything not "dd/mm_"-prefixed — a manually installed
    guided workout, a generic Suunto App) are never touched, matching the module docstring's
    standing rule."""
    existing = WI.apps_entries_with_raw_blocks(current_apps_bytes)
    manual = [e for e in GW.native_names(existing) if not is_managed(e)]
    slots = max(menu_max - len(manual), 0)
    upcoming, seen = [], set()
    for e in sorted(plan_entries, key=lambda e: e["date"]):
        label = entry_label(e["date"], e["workout"]["name"])
        # Already past — never install it, whether or not it was ever installed.
        if datetime.date.fromisoformat(e["date"]) >= today and label not in seen:
            seen.add(label)
            upcoming.append((label, e))
    window = {label for label, _ in upcoming[:slots]}
    waiting = [label for label, _ in upcoming[slots:]]

    kept = [e["_raw_block"] for e in existing if not is_managed(e["name"]) or e["name"] in window]
    names_present = {e["name"] for e in existing}
    to_add = [e for label, e in upcoming[:slots] if label not in names_present]
    return kept, to_add, waiting


def workout_modes(decoded, sport):
    """The modes of `sport` (ActivityID) named as the plan's workout mode (WORKOUT_MODE_RE)."""
    return [m for m in decoded["exercise_modes"]
            if m["Settings"].get("ActivityID") == sport
            and WORKOUT_MODE_RE.search(m["Settings"].get("Name") or "")]


def auto_start_rules(decoded, existing, new_apps_bytes, plan_entries, today, auto_start):
    """Edit `decoded` (custom_modes.decode output) in place so that each plan sport's WORKOUT
    MODE ("Running workout", see WORKOUT_MODE_RE) runs every installed upcoming workout of
    that sport as an active rule - all of them at once, each gated on its own date
    (iamrule_code.add_date_gate), so the watch's own clock picks the day's one and the other
    four do nothing. A RULE in a mode's RULES list is an ACTIVE engine slot (hardware
    2026-08-19; 2026-10-05 on André's Peak: card -> Start -> Running -> "Brisk Walk 5' 1/6",
    the step's own HR band, no WORKOUT menu).

    Why the watch's clock and not the sync (2026-10-09/10): a rule pointed at the next workout
    only at sync time ran the 5th's workout on the 7th; André: "try to have a workaround to
    work properly without connecting". Why one named mode and not every mode of the sport
    (André, 2026-10-10: "I want to be able to select from here. not automatically when
    running"): the card's Start opens the sport list, so "Running workout" is the day's
    workout and "Running" a free run. The card itself cannot tell a workout it was pressed.

    First every rule in ANY mode that points at a managed ("dd/mm_") entry is dropped (that is
    how the feature is switched off, auto_start=False); then, per sport (ActivityID) with
    installed upcoming workouts, its workout mode(s) get one rule per workout, soonest first,
    as far as the five slots go. A sport with no workout mode is reported in `needs_mode`
    (the desktop offers to create one) and gets no rules.
    Returns (touched_mode_names, [{"sport", "mode", "workouts"}], [{"sport", "mode",
    "suggested"}])."""
    old_names = {i: e["name"] for i, e in enumerate(existing)}
    # Rules are compared at the end, so a sync that changes nothing rewrites no sport mode
    # (the plug-in sync runs on every connection - 2026-10-10).
    before_rules = {m["Settings"]["Name"]: list(m.get("Rules") or []) for m in decoded["exercise_modes"]}
    for mode in decoded["exercise_modes"]:
        mode["Rules"] = [r for r in (mode.get("Rules") or [])
                         if not is_managed(old_names.get(r["RuleIdx"], ""))]

    def touched_modes():
        return [m["Settings"]["Name"] for m in decoded["exercise_modes"]
                if (m.get("Rules") or []) != before_rules[m["Settings"]["Name"]]]
    if not auto_start:
        return touched_modes(), [], []
    installed = {e["name"]: i for i, e in enumerate(apps.decode(new_apps_bytes))}
    by_sport = {}   # ActivityID -> [label, ...] of the installed upcoming workouts, soonest first
    for e in sorted((e for e in plan_entries if e["date"] >= str(today)), key=lambda e: e["date"]):
        try:
            sport = GW.mode_activity_id(decoded, e["mode"])
        except SystemExit:
            continue
        label = entry_label(e["date"], e["workout"]["name"])
        if label in installed and label not in by_sport.setdefault(sport, []):
            by_sport[sport].append(label)
    out, needs_mode = [], []
    for sport, labels in by_sport.items():
        modes = workout_modes(decoded, sport)
        if not modes:
            first = next(m["Settings"]["Name"] for m in decoded["exercise_modes"]
                         if m["Settings"].get("ActivityID") == sport)
            needs_mode.append({"sport": sport, "mode": first, "suggested": f"{first} workout"})
            continue
        for mode in modes:
            room = WI.SPORT_MODE_APP_LIMIT - len(mode.get("Rules") or [])
            chosen = labels[:max(room, 0)]
            mode.setdefault("Rules", []).extend(
                {"RuleIdx": installed[l], "UseRule": True, "LogRule": False} for l in chosen)
            out.append({"sport": sport, "mode": mode["Settings"]["Name"], "workouts": chosen})
    return touched_modes(), out, needs_mode


def sync(link, plan, today, write, json_out, auto_start=None):
    mm = read_memory_map(link)
    cm_base, cm_size = mm["CustomModes"]
    apps_base, apps_size = mm["Apps"]
    current_cm = read_flash(link, cm_base, cm_size, label="CustomModes")
    current_apps = read_flash(link, apps_base, apps_size, label="Apps")

    kept_blocks, to_add, waiting = plan_diff(current_apps, plan["entries"], today)
    existing = WI.apps_entries_with_raw_blocks(current_apps)
    kept_block_set = set(kept_blocks)
    # Everything managed that didn't survive the diff — expired or removed from the plan. One
    # moved back to waiting for a free slot is erased too, but reported under "waiting".
    removed = [e["name"] for e in existing
               if is_managed(e["name"]) and e["_raw_block"] not in kept_block_set
               and e["name"] not in waiting]

    decoded = cm.decode(current_cm)
    lang = GW.read_watch_language(link)
    by_label = {entry_label(e["date"], e["workout"]["name"]): e for e in plan["entries"]}
    if not auto_start:
        # A date-gated workout does nothing on any other day, which is wrong for a WORKOUT-
        # menu pick; the gate cannot be taken out of a compiled binary, so such a kept
        # workout is reinstalled plain.
        for e in existing:
            if (is_managed(e["name"]) and e["_raw_block"] in kept_block_set
                    and is_gated(e["binary"]) and e["name"] in by_label):
                kept_block_set.discard(e["_raw_block"])
                to_add.append(by_label[e["name"]])
    # Kept workouts from before 2026-10-05 carry a per-sport byte (a pick could run another
    # sport's workout) and rule id 0. Repair them while we are rewriting the region anyway.
    current_list, restamped = GW.restamp_rule_ids(
        [e for e in existing if e["_raw_block"] in kept_block_set])
    gated = []
    if auto_start:
        # Every managed workout reads the watch's date (iamrule_code.add_date_gate), so all
        # of them can be active rules at once and the day's one runs by itself.
        current_list, gated = gate_managed(
            current_list, {n: e["date"] for n, e in by_label.items()})
    kept_blocks = [e["_raw_block"] for e in current_list]
    added_names = []
    failed = []  # [(label, error)] — one bad workout in the plan must not sink the whole sync
    new_apps_bytes = None
    for e in to_add:
        label = entry_label(e["date"], e["workout"]["name"])
        try:
            GW.mode_activity_id(decoded, e["mode"])  # fail fast on an unknown mode name
            compiled = GW.compile_workout(e["workout"], lang)
        except SystemExit as err:
            failed.append((label, str(err)))
            continue
        compiled["name"] = label
        compiled["activityId"] = GW.ANY_MODE_ACTIVITY  # row == slot in every mode, see guided_workout
        # A unique rule id per installed workout, or the watch runs the first one with the same
        # id whatever was picked (GW.with_rule_id; André's swim-instead-of-run, 2026-10-05).
        rule_id = GW.free_rule_id(current_list)
        if rule_id is None:
            failed.append((label, "no free rule id (1..9) left among the installed workouts"))
            continue
        compiled["binary"] = GW.with_rule_id(compiled["binary"], rule_id)
        if auto_start:
            compiled["binary"] = gated_binary(compiled["binary"], e["date"])
            gated.append(label)
        new_apps_bytes = WI.build_apps_region(current_list, compiled, entry_type=GW.GUIDANCE_ENTRY_TYPE)
        current_list = WI.apps_entries_with_raw_blocks(new_apps_bytes)
        added_names.append(compiled["name"])
    if new_apps_bytes is None:
        new_apps_bytes = rebuild_apps_region(kept_blocks)  # also carries any re-stamped ids

    # Ensure every mode named by a kept-or-added entry has the guidance display so its
    # WORKOUT menu is surfaced at all (harmless no-op if it's already there).
    modes_needed = {e["mode"] for e in plan["entries"] if e["date"] >= str(today)} | \
                   {e.get("mode") for e in to_add}
    modes_touched = []
    for mode_name in sorted(m for m in modes_needed if m):
        idx = GW.find_mode_index(decoded, mode_name)
        mode = decoded["exercise_modes"][idx]
        if not any(d.get("Template") == GW.GUIDANCE_TEMPLATE for d in mode.get("Displays", [])):
            mode.setdefault("Displays", []).append(GW.guidance_display())
            modes_touched.append(mode_name)
    # With auto-start, each plan sport's workout mode(s) need the guidance display too - that
    # is where the steps show.
    if auto_start:
        sports = set()
        for e in plan["entries"]:
            if e["date"] >= str(today):
                try:
                    sports.add(GW.mode_activity_id(decoded, e["mode"]))
                except SystemExit:
                    pass
        for sport in sports:
            for mode in workout_modes(decoded, sport):
                if not any(d.get("Template") == GW.GUIDANCE_TEMPLATE
                           for d in mode.get("Displays", [])):
                    mode.setdefault("Displays", []).append(GW.guidance_display())
                    modes_touched.append(mode["Settings"]["Name"])
    rules_touched, auto, needs_mode = auto_start_rules(
        decoded, existing, new_apps_bytes, plan["entries"], today, auto_start)
    modes_touched = sorted(set(modes_touched) | set(rules_touched))
    # Sport modes are written only when a display or rule actually changed, and then only as the
    # used extent. Writing back the raw 12 KB region read above (the old "unchanged" path) leaves a
    # closing hash the firmware rejects on the next restart - "Connect to Moveslink" and
    # factory-default sport modes (André's Peak, 2026-09-26). write_nav.send_plan now refuses it.
    new_cm_bytes = cmw.build_custom_modes_body(decoded, decoded.get("format_type", 2)) \
        if modes_touched else None
    if new_cm_bytes is not None and cm.check_field_type_shortcut_invariant(new_cm_bytes):
        # Finding 53's "connect to Moveslink" root cause - refuse rather than write it.
        result = {"ok": False, "written": False,
                  "error": "the rebuilt sport modes break the field Type/Shortcut invariant - "
                           "nothing written"}
        print(json.dumps(result) if json_out else f"  !! {result['error']}")
        return result

    result = {"ok": True, "today": str(today), "removed": removed, "added": added_names,
              "failed": [{"name": n, "error": err} for n, err in failed],
              "waiting": waiting, "menuMax": GW.WORKOUT_MENU_MAX,
              "displaysAdded": modes_touched, "appsBytes": len(new_apps_bytes),
              "repaired": [n for n, _ in restamped], "autoStart": auto,
              "needsMode": needs_mode, "dateGated": gated}

    if not json_out:
        print(f"sync as of {today}:")
        print(f"  erase: {removed or '(none)'}")
        print(f"  install: {added_names or '(none)'}")
        if waiting:
            print(f"  waiting for a free slot (menu shows {GW.WORKOUT_MENU_MAX}): {len(waiting)}")
        if failed:
            print(f"  FAILED to compile (skipped, rest of sync still applied):")
            for n, err in failed:
                print(f"    {n}: {err}")
        if modes_touched:
            print(f"  sport modes rewritten (guidance display / auto-start rule): {modes_touched}")
        for x in auto:
            print(f"  auto-start: {x['mode']!r} runs the day's workout by date: {x['workouts']}")
        for x in needs_mode:
            print(f"  !! no workout mode for sport {x['sport']} - create {x['suggested']!r} "
                  f"(the card's Start lists it next to {x['mode']!r})")
        if gated:
            print(f"  date-gated (run only on their day): {gated}")
        if restamped:
            print(f"  repaired (any-mode sport byte / rule id): {[n for n, _ in restamped]}")
        if not removed and not added_names and not modes_touched and not failed and not restamped:
            print("  nothing to do — watch already matches the plan")

    if not write:
        result["written"] = False
        if json_out:
            print(json.dumps(result))
        else:
            print("dry-run: pass --write to apply")
        return result

    import pathlib
    backup = f"backups/CustomModes_pre_calendar_{int(time.time())}.bin"
    pathlib.Path(backup).parent.mkdir(parents=True, exist_ok=True)
    open(backup, "wb").write(current_cm)
    writes = [("Apps", apps_base, new_apps_bytes)]
    if new_cm_bytes is not None:
        writes.append(("CustomModes", cm_base, new_cm_bytes))
    for name, base, blob in writes:
        fi = FlashImage(); fi.write(base, blob)
        send_plan(link, fi, [(name, base, blob), ("t", base, None)], commit=False)
    if new_cm_bytes is not None:
        # Read back and roll back on a mismatch - a CustomModes write once landed 54 bytes
        # shifted (2026-08-25, workout_install.py) and scrambled every mode after the target.
        back = bytes(read_flash(link, cm_base, len(new_cm_bytes), label="CustomModes (verify)"))
        if back != bytes(new_cm_bytes):
            old = bytes(current_cm[:cm.used_extent(current_cm)])
            fi = FlashImage(); fi.write(cm_base, old)
            send_plan(link, fi, [("CustomModes (rollback)", cm_base, old), ("t", cm_base, None)],
                      commit=False)
            result.update(ok=False, written=True, autoStart=[],
                          error="sport modes read back wrong after the write; restored the "
                                "previous sport modes (workouts were installed, auto-start was not)")
            print(json.dumps(result) if json_out else f"  !! {result['error']}")
            return result
    result["written"] = True
    result["customModesWritten"] = new_cm_bytes is not None
    result["backup"] = backup
    if json_out:
        print(json.dumps(result))
    else:
        print(f"  written. CustomModes backed up -> {backup}")
    return result


def remove_native_entry(current_apps_bytes, name):
    """Apps region with the native guided workout `name` taken out - for a manually installed
    one the sync never touches (e.g. the Builder's "Light workout"). Guarded by
    guided_workout.without_native (native entries only, never shifting a Suunto App)."""
    existing = WI.apps_entries_with_raw_blocks(current_apps_bytes)
    return rebuild_apps_region([e["_raw_block"] for e in GW.without_native(existing, name)])


def remove(link, name, write, json_out):
    mm = read_memory_map(link)
    apps_base, apps_size = mm["Apps"]
    current_apps = read_flash(link, apps_base, apps_size, label="Apps")
    try:
        new_apps_bytes = remove_native_entry(current_apps, name)
    except ValueError as err:
        result = {"ok": False, "error": str(err)}
        print(json.dumps(result) if json_out else f"refused: {err}")
        return result
    result = {"ok": True, "removed": [name], "appsBytes": len(new_apps_bytes), "written": False}
    result["remaining"] = [e["name"] for e in apps.decode(new_apps_bytes)]
    if write:
        import pathlib
        backup = f"backups/Apps_pre_remove_{int(time.time())}.bin"
        pathlib.Path(backup).parent.mkdir(parents=True, exist_ok=True)
        open(backup, "wb").write(current_apps)
        result["backup"] = backup
        fi = FlashImage(); fi.write(apps_base, new_apps_bytes)
        send_plan(link, fi, [("Apps", apps_base, new_apps_bytes), ("t", apps_base, None)],
                  commit=False)
        result["written"] = True
    if json_out:
        print(json.dumps(result))
    else:
        print(f"remove {name!r}: " + ("written" if write else "dry-run: pass --write to apply"))
    return result


def list_calendar(link, json_out):
    mm = read_memory_map(link)
    apps_base, apps_size = mm["Apps"]
    current_apps = read_flash(link, apps_base, apps_size, label="Apps")
    existing = WI.apps_entries_with_raw_blocks(current_apps)
    managed = [e["name"] for e in existing if is_managed(e["name"])]  # watch (menu) order
    if json_out:
        print(json.dumps({"managed": managed}))
    else:
        if not managed:
            print("no dated calendar workouts installed")
        for name in managed:
            print(f"  {name}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("plan", nargs="?", help="plan JSON file (see this file's docstring)")
    ap.add_argument("--sync", action="store_true", help="diff the plan against the watch")
    ap.add_argument("--list", action="store_true", help="list installed dated calendar workouts")
    ap.add_argument("--remove", metavar="NAME",
                    help="remove one native workout by its on-watch name (e.g. 'Light workout')")
    ap.add_argument("--today", metavar="YYYY-MM-DD", help="override today's date (testing)")
    ap.add_argument("--auto-start", action="store_true",
                    help="each plan sport's workout mode ('Running workout') runs the day's"
                         " workout by itself: every installed workout is an active rule there,"
                         " gated on its own date by the watch's clock (see auto_start_rules)."
                         " The Today card's Start -> that mode -> the steps run; any other mode"
                         " is a free run. Without it such rules from an earlier sync are removed"
                         " and gated workouts are reinstalled plain for the WORKOUT menu.")
    ap.add_argument("--write", action="store_true", help="actually write (else dry-run)")
    ap.add_argument("--json", action="store_true", help="print one-line JSON (for a GUI)")
    args = ap.parse_args()

    link = Link(dry_run=False)
    link.open()
    link.command(CMD_DEVICE_INFO, b"\x02\x48\x03\x00")

    if args.list:
        list_calendar(link, args.json)
        return 0
    if args.remove:
        return 0 if remove(link, args.remove, args.write, args.json).get("ok") else 1

    if not args.sync or not args.plan:
        ap.error("PLAN.json --sync is required (or use --list)")

    plan = json.load(open(args.plan))
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.date.today()
    result = sync(link, plan, today, args.write, args.json, auto_start=args.auto_start)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
