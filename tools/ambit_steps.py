#!/usr/bin/env python3
"""Daily steps of an Ambit3, read from the watch's own 30-day history. Read-only.

The watch keeps 30 daily step counts, oldest first; the last one is today's count so far.
They live in `sml.DeviceHistory` and come back from the same `0x1200` object query that
reads the logbook, asked with the DeviceHistory query id instead:

    request  [u32 cursor 0][u16 1][u16 10] "SBEM0102" [u16 query id]
    reply    [u32 cursor][u16 last] "SBEM0102" entries

Fields used (Ambit3 Peak fw 2.4.17, ids from the watch's own schema descriptor):

    0x97   QUERY  sml.DeviceHistory
    0x12e  GROUP  ...History.ActivitySummary.LastDays.Steps   30 x u32 (0x12d Steps+Value)
    0x130         sml.DeviceHistory.Timestamp                 "2026-10-18T13:06:02+03:00"

The timestamp is the watch's local time when it answered; its date is the date of the last
(today's) slot. 0xFFFFFFFF in a slot means the watch has no count for that day. Only the
date and clock are used: the "+03:00" offset is not the watch's real zone (André's Peak sent
14:19+03:00 at 14:19 CEST, and the emulated watch sends +03:00 too).

Where this comes from:
  - the firmware: query 0x97 and the 30 x u32 record were found in the watch program and run
    in the emulator (tools/emu, ticket watch-emulator/01);
  - the watch: read from André's Ambit3 Peak over USB on 2026-10-18 (4 days with counts, 26
    without);
  - Suunto's own Movescount Android app (libkomposti) reads `sml.DeviceHistory` from an
    Ambit3 before a firmware update and writes it back after it. No capture in assets/ shows
    a DeviceHistory read on the wire.

The same reply also carries `ActivityTracking` (daily recovery, daily and weekly activity);
those are returned raw under "activity_tracking", their units not yet checked on a watch.

The query id differs between firmware versions (the logbook is 0x8c on older Ambit3
firmware, 0x8d on 2.4.17), so the id is looked up in the watch's own schema descriptor when
one is on this computer, and otherwise only the 2.4.17 table is used. The reply is checked
for the expected layout (a 120-byte steps entry and an ISO timestamp) before anything is
returned, so a firmware with a different numbering gives an error rather than wrong numbers.

    ./tools/ambit_steps.py            # USB
    ./tools/ambit_steps.py --ble      # Bluetooth (the watch must be in sync/pair mode)
    ./tools/ambit_steps.py --json     # one JSON object, for the desktop backend
"""

import argparse
import datetime
import json
import struct
import sys

import sbem_schema

CMD_SML_QUERY = 0x1200

# Ambit3 Peak / Sport / Run fw 2.4.17 (assets/descr+<serial>+2.4.17).
REFERENCE_IDS = {"query": 0x97, "steps": 0x12E, "timestamp": 0x130,
                 "recovery": 0x92, "daily_activity": 0x93, "weekly_activity": 0x94,
                 "total_weekly_activity": 0x95}
DAYS = 30
NO_COUNT = 0xFFFFFFFF


def request(query_id, cursor=0):
    return struct.pack("<IHH", cursor, 1, 10) + sbem_schema.MAGIC + struct.pack("<H", query_id)


def resolve_ids(serial=None, fw=None, path=None):
    """(ids, source) for this watch: its own descriptor when one is found, else the 2.4.17
    table. `source` says which, for the JSON output."""
    path = path or sbem_schema.default_descriptor(serial, fw)
    if path.is_file():
        try:
            schema = sbem_schema.load(path)
            query = next((fid for fid, p in schema.queries.items()
                          if p == "sml.DeviceHistory"), None)
            if query is not None:
                ids = dict(REFERENCE_IDS)
                ids["query"] = query
                if query != REFERENCE_IDS["query"]:
                    # Other numbering: the group ids would differ too. Use only what the
                    # descriptor names; the layout check below refuses anything else.
                    ids.update({k: None for k in REFERENCE_IDS if k != "query"})
                return ids, f"descriptor {path.name.split('+')[-1]}"
        except (OSError, ValueError):
            pass
    return dict(REFERENCE_IDS), "fw 2.4.17 table"


def walk(payload):
    """(entry id, data) pairs of the reply, long ids included (sbem_schema.entries)."""
    head = payload.find(sbem_schema.MAGIC)
    if head < 0:
        raise ValueError("no SBEM0102 payload in the reply")
    return list(sbem_schema.entries(payload[head:]))


def read_raw(link, query_id):
    """All pages of one 0x1200 query, as a list of (entry id, data). The last page has
    cursor 0 (seen in three captures and in the firmware, ble_logs.py)."""
    out, cursor = [], 0
    for _ in range(64):
        reply = link.command(CMD_SML_QUERY, request(query_id, cursor), quiet=True)
        if len(reply) < 6:
            raise ValueError(f"short reply to the DeviceHistory query ({len(reply)} bytes)")
        cursor, _last = struct.unpack_from("<IH", reply, 0)
        out += walk(reply)
        if cursor == 0:
            return out
    raise ValueError("the DeviceHistory query did not finish within 64 pages")


def decode(entries, ids):
    """{"timestamp", "days": [{"date", "steps"}], "activity_tracking": {...}} from the reply
    entries. Raises ValueError when the layout is not the expected one."""
    by_id = {}
    for eid, data in entries:
        by_id.setdefault(eid, []).append(data)
    steps_raw = (by_id.get(ids["steps"]) or [None])[0] if ids.get("steps") else None
    ts_raw = (by_id.get(ids["timestamp"]) or [None])[0] if ids.get("timestamp") else None
    if steps_raw is None or len(steps_raw) != DAYS * 4:
        raise ValueError("the reply has no 30-day steps record in the expected place "
                         f"(entry 0x{ids.get('steps') or 0:x}) - unknown firmware numbering")
    if ts_raw is None:
        raise ValueError("the reply has no DeviceHistory timestamp")
    stamp = ts_raw.split(b"\0")[0].decode("ascii", "replace")
    try:
        when = datetime.datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise ValueError(f"unexpected DeviceHistory timestamp {stamp!r}") from exc
    today = when.date()
    counts = struct.unpack(f"<{DAYS}I", steps_raw)
    days = []
    for i, n in enumerate(counts):
        if n == NO_COUNT:
            continue
        day = today - datetime.timedelta(days=DAYS - 1 - i)
        days.append({"date": day.isoformat(), "steps": n, "today": i == DAYS - 1})

    def u16s(key):
        eid = ids.get(key)
        data = b"".join(by_id.get(eid, [])) if eid is not None else b""
        return list(struct.unpack(f"<{len(data) // 2}H", data[:len(data) // 2 * 2]))

    return {
        "timestamp": stamp,
        "days": days,
        # Raw values, units not checked on a watch yet (schema <MOD>: recovery x*60*22.5,
        # activity 4184*x). Kept so a later change can show them without another read.
        "activity_tracking": {k: u16s(k) for k in
                              ("recovery", "daily_activity", "weekly_activity",
                               "total_weekly_activity")},
    }


def _own_schema(link):
    """The watch's own schema over the cable (sbem_schema.for_link: our cache, SuuntoLink's
    folder, assets/, else read off the watch), so a machine without SuuntoLink still names the
    ids of a firmware other than 2.4.17. None over Bluetooth (the schema read is untried there)
    or when the read fails: then the stored lookup and the 2.4.17 table, as before."""
    from write_nav import Link
    if type(link) is not Link or getattr(link, "dry_run", False):
        return None
    try:
        return sbem_schema.for_link(link)
    except Exception:  # hid backends and short replies each raise their own type
        return None


def read_steps(link, serial=None, fw=None):
    ids, source = resolve_ids(serial, fw, _own_schema(link))
    result = decode(read_raw(link, ids["query"]), ids)
    return {"ok": True, "ids_from": source, "query": ids["query"], **result}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ble", action="store_true", help="read over Bluetooth instead of USB")
    ap.add_argument("--address", help="Bluetooth address (with --ble); scans when omitted")
    ap.add_argument("--json", action="store_true",
                    help="print one JSON object (for desktop/backend/server.py)")
    args = ap.parse_args()

    if args.ble:
        from ble_link import BleLink
        link = BleLink(dry_run=False, address=args.address)
    else:
        from write_nav import Link
        link = Link(dry_run=False)
    try:
        if args.json:
            import contextlib
            import io
            with contextlib.redirect_stdout(io.StringIO()):
                link.open()
                from device_info import read_device_info
                info = read_device_info(link)
                result = read_steps(link, info.get("serial"), info.get("fw_version"))
            result["serial"] = info.get("serial")
            result["fw_version"] = info.get("fw_version")
            print(json.dumps(result))
            return 0
        link.open()
        from device_info import read_device_info
        info = read_device_info(link)
        result = read_steps(link, info.get("serial"), info.get("fw_version"))
    except (ValueError, RuntimeError, OSError) as exc:
        if args.json:
            print(json.dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        if hasattr(link, "close"):
            try:
                link.close()
            except Exception:  # noqa: BLE001 - closing is best effort
                pass

    print(f"watch time {result['timestamp']}  (query 0x{result['query']:x}, "
          f"ids from {result['ids_from']})")
    if not result["days"]:
        print("no daily step counts on the watch")
    for d in result["days"]:
        print(f"  {d['date']}  {d['steps']:7d}{'  (today, so far)' if d['today'] else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
