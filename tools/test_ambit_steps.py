#!/usr/bin/env python3
"""Checks for ambit_steps.py and the long-id SBEM entries it relies on. No watch needed.

The reply below has the shape of a real Ambit3 Peak DeviceHistory reply (fw 2.4.17, read
2026-10-18): short-id ActivityTracking entries, then the steps record and the timestamp in
the long-id form `[ff][u16 id][len]`. The numbers are made up.
"""
import struct
import sys

import ambit_steps as S
import sbem_schema


def entry(eid, data):
    head = bytes([eid]) if eid < 0xFF else b"\xff" + struct.pack("<H", eid)
    return head + bytes([len(data)]) + data


def reply(steps, stamp=b"2026-10-18T13:06:02+03:00\x00", cursor=0):
    body = (entry(0x92, struct.pack("<3H", 77, 76, 75))
            + entry(0x94, struct.pack("<2H", 2933, 680))
            + entry(0x12E, struct.pack("<30I", *steps))
            + entry(0x130, stamp))
    return struct.pack("<IH", cursor, 1) + sbem_schema.MAGIC + body


class FakeLink:
    def __init__(self, pages):
        self.pages, self.sent = list(pages), []

    def command(self, command, payload=b"", expect_reply=True, quiet=False):
        self.sent.append((command, payload))
        return self.pages.pop(0)


def main():
    fails = []

    def check(name, cond):
        if not cond:
            fails.append(name)

    # 1. the walker reads long ids and keeps short ones
    ids = [eid for eid, _ in sbem_schema.entries(reply([1] * 30)[6:])]
    check("long ids walked", ids == [0x92, 0x94, 0x12E, 0x130])

    # 2. request bytes = the shape of the logbook query, with the DeviceHistory id
    check("request", S.request(0x97) == bytes.fromhex("00000000" "0100" "0a00")
          + b"SBEM0102" + b"\x97\x00")

    # 3. decode: oldest first, no-count slots dropped, last slot dated by the timestamp
    counts = [S.NO_COUNT] * 26 + [17194, 6759, 5798, 5]
    link = FakeLink([reply(counts)])
    out = S.decode(S.read_raw(link, 0x97), S.REFERENCE_IDS)
    check("one request", len(link.sent) == 1 and link.sent[0][0] == 0x1200)
    check("days", [(d["date"], d["steps"]) for d in out["days"]] == [
        ("2026-10-15", 17194), ("2026-10-16", 6759), ("2026-10-17", 5798), ("2026-10-18", 5)])
    check("today flag", [d["today"] for d in out["days"]] == [False, False, False, True])
    check("raw activity", out["activity_tracking"]["recovery"] == [77, 76, 75]
          and out["activity_tracking"]["weekly_activity"] == [2933, 680])

    # 3b. activity and recovery: quarter-hour samples ending at the last quarter hour before
    #     the timestamp (13:06 -> 13:00), weekly days ending today, recovery in 22.5-min units
    act, rec = out["activity"], out["recovery"]
    check("recovery now", rec["hours"] == 28.12 and [s["time"] for s in rec["samples"]] == [
        "2026-10-18T12:30", "2026-10-18T12:45", "2026-10-18T13:00"])
    check("week days", act["week"] == [
        {"date": "2026-10-17", "kcal": 2933, "today": False},
        {"date": "2026-10-18", "kcal": 680, "today": True}] and act["today_kcal"] == 680)
    check("no daily samples", act["samples"] == [])

    # 4. paging: a first page with a cursor is followed by a second request at that cursor
    link = FakeLink([struct.pack("<IH", 0x18, 0) + sbem_schema.MAGIC + entry(0x92, b"\1\0"),
                     reply(counts)])
    S.read_raw(link, 0x97)
    check("paged", len(link.sent) == 2 and link.sent[1][1][:4] == struct.pack("<I", 0x18))

    # 5. a reply with another layout is refused, not decoded
    bad = struct.pack("<IH", 0, 1) + sbem_schema.MAGIC + entry(0x12E, b"\0" * 64)
    try:
        S.decode(S.walk(bad), S.REFERENCE_IDS)
        check("wrong layout refused", False)
    except ValueError:
        pass

    if fails:
        print("FAILED:", ", ".join(fails))
        return 1
    print("ambit_steps: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
