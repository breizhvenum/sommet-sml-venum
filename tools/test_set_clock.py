#!/usr/bin/env python3
"""set_time.set_clock(), which every desktop sync calls (🟣35): which clock command each watch
gets, by its USB product name or its Bluetooth hello's codename, and the bytes sent. No watch."""

import pathlib
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import set_time as T  # noqa: E402

NOW = datetime(2026, 10, 25, 17, 5, 9, tzinfo=timezone(timedelta(hours=0)))


class Fake:
    def __init__(self):
        self.sent = []

    def command(self, cmd, payload=b"", quiet=False):
        self.sent.append((cmd, payload))
        return b""


def main():
    families = {"Ambit3 Peak (Emu)": None, "Emu": None, "Ambit2": None, "": None, None: None,
                "Kailash (Hoopoe)": "kailash", "Hoopoe": "kailash",
                "Traverse (Jabiru)": "traverse", "Traverse Alpha (Loon)": "traverse",
                "Jabiru": "traverse", "Loon": "traverse"}
    for name, family in families.items():
        assert T.clock_family(name) == family, (name, T.clock_family(name))

    ambit = Fake()
    assert T.set_clock(ambit, None, NOW) == "2026-10-25T17:05:09+00:00"
    assert ambit.sent == [(0x0302, bytes.fromhex("ea070a19" "28000000")),
                          (0x0300, bytes.fromhex("ea070a191105" "2823"))], ambit.sent

    for family, entry in (("kailash", 0x34), ("traverse", 0x3f)):
        link = Fake()
        T.set_clock(link, family, NOW)
        ((cmd, payload),) = link.sent
        text = b"2026-10-25T17:05:09+0000\0"
        assert cmd == 0x1201 and payload == (bytes(4) + b"\x01\x00SBEM0102"
                                              + bytes([entry, len(text)]) + text), payload
    print("ok  each watch family gets its own clock command")


if __name__ == "__main__":
    main()
