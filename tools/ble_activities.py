#!/usr/bin/env python3
"""Recorded activities (ExerciseLog) over BLE, phone-driven, post-handshake.

Own file, this project's own "one file per format" convention. Unlike `ble_logs.py`
(this project's earlier, abandoned attempt at the real Suunto app's own phone-pull 0x1200
sequence - no known stop condition, never finished), `exercise_log.py`'s USB implementation
takes a much simpler route that turns out to need no BLE-specific work at all: it reads the
whole ExerciseLog region via plain 0x0b17 flash reads (`read_flash()`, the exact mechanism
already proven reliable over BLE for routes tonight - 146KB read clean, self-validating via
the region's own CRC) and decodes it locally. This file only replicates `exercise_log.py
main()`'s own watch-reading sequence (probe the real used size, read only that, walk the
entries) against a `link` instead of duplicating it inline - the actual sample/GPX/FIT
decode is 100% reused, unchanged.
"""

import struct
import sys

from exercise_log import (
    EXERCISE_LOG_BASE, EXERCISE_LOG_SIZE, parse_master_header, to_fit, to_gpx, walk_entries,
)
from write_nav import read_flash

CMD_LOCK_CHECK = 0x0b19
CMD_LOCK_SET = 0x0b1a


def sync_lock(link, on):
    """Takes (on) or releases (off) the watch's sync lock around a Bluetooth sync, as the
    Suunto app does (btsnoop 2026-08-09: 0x0b19/0x0b1a 1 at the start, 0 at the end) and the
    Android app does over Bluetooth (HomeScreen, syncDisplay). The watch shows "Syncing" while
    it is held; without it a "Sync now" pressed on the watch ended in "Sync failed" although
    the sync ran. Same steps as libambit_device_driver_lock_log(): set only a free lock, clear
    only a held one, nothing when the check fails. Best-effort: False instead of raising."""
    try:
        reply = link.command(CMD_LOCK_CHECK, b"")
        held = int.from_bytes(reply[:4], "little") if len(reply) >= 4 else None
        if on and held == 0:
            link.command(CMD_LOCK_SET, b"\x01\x00\x00\x00")
        elif not on and held == 1:
            link.command(CMD_LOCK_SET, b"\x00\x00\x00\x00")
        return held is not None
    except Exception:                                    # noqa: BLE001 - the sync goes on without it
        return False


def read_activities(link, known_count=0):
    """Returns (master, entries) - same shape `exercise_log.py main()`'s own watch-reading
    branch produces. `entries` is a list of (header, samples) tuples; pass each to
    `to_gpx()`/`to_fit()` for export, same as the USB CLI does."""
    probe = read_flash(link, EXERCISE_LOG_BASE, 1024, label="ExerciseLog (header)")
    probe_master = parse_master_header(probe)
    needed = probe_master["next_free_address"] - EXERCISE_LOG_BASE + 8192
    needed = max(1024, min(EXERCISE_LOG_SIZE, needed))
    data = read_flash(link, EXERCISE_LOG_BASE, needed, label="ExerciseLog")
    try:
        entries = list(walk_entries(data, skip_count=known_count))
    except (IndexError, struct.error):
        data = read_flash(link, EXERCISE_LOG_BASE, EXERCISE_LOG_SIZE, label="ExerciseLog")
        entries = list(walk_entries(data, skip_count=known_count))
    master = parse_master_header(data)
    return master, entries


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--known-count", type=int, default=0, metavar="N")
    args = ap.parse_args()

    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent
                           / "desktop" / "backend"))
    import ble_bridge                                        # noqa: PLC0415

    bridge = ble_bridge.BleBridge()
    status = bridge.status()
    if not status.get("handshake_done"):
        print("no BLE connection with a completed handshake - connect first")
        return 1
    bridge.set_dry_run(False)
    master, entries = read_activities(bridge, args.known_count)
    print(f"master: entries={master['entries']}")
    for header, samples in entries:
        print(f"  {header['activity_name']!r} {header['year']:04d}-{header['month']:02d}-"
              f"{header['day']:02d}, {len(samples)} sample(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
