#!/usr/bin/env python3
"""The POI store as the Ambit3 firmware runs it (MSP430X Emu 2.4.17, read 2026-10-24):
0x0b25 APPENDS each record it is given, 0x0b02 counts the store, and 0x0b24 answers in
pages of [u16 nextCursor][u16 0][u16 isLast][data] with the SBEM header on the first page
only. Adding a POI used to send "new + everything already there", which doubled the list
on every add; reading took the first page only."""
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import ble_pois  # noqa: E402
import write_nav as W  # noqa: E402

MAGIC = b"SBEM0102"


class FakeWatch:
    """Enough of the watch's POI commands to tell an append from a replace."""

    def __init__(self, page_data=0x3FA):
        self.records = []
        self.page_data = page_data
        self.dry_run = False
        self.sent = []

    def command(self, command, payload=b"", **_):
        self.sent.append(command)
        if command == W.CMD_POI_COUNT:
            return len(self.records).to_bytes(4, "little")
        if command == W.CMD_POI_WRITE:
            body = payload[len(W.SBEM_WRITE_PREFIX) + len(MAGIC):]
            assert body[0] == W.POI_ENTRY
            if body[1] == 0xFF:
                size, data = int.from_bytes(body[2:6], "little"), body[6:]
            else:
                size, data = body[1], body[2:]
            assert len(data) == size
            # One 0x55 entry may carry several records back to back (name, route name and
            # stamp NUL-terminated, then 5 + 8 bytes); each is appended, never replacing.
            off = 0
            while off < len(data):
                end = off
                for _ in range(3):
                    end = data.index(b"\0", end) + 1
                end += 13
                self.records.append(bytes(data[off:end]))
                off = end
            return b""
        if command == W.CMD_POI_READ:
            if not self.records:
                return b""                       # an empty store: error, no data (USB: b"")
            # A name over 15 bytes is kept but listed as an empty entry (André's Peak 2026-10-25).
            shown = [b"" if len(r.split(b"\0")[0]) > 15 else r for r in self.records]
            stream = MAGIC + b"".join(bytes([W.POI_ENTRY, len(r)]) + r for r in shown)
            cursor = int.from_bytes(payload[:2], "little")
            chunk = stream[cursor:cursor + self.page_data]
            nxt = cursor + len(chunk)
            last = nxt >= len(stream)
            head = (0 if last else nxt).to_bytes(2, "little") + b"\0\0" + int(last).to_bytes(2, "little")
            return head + chunk
        raise AssertionError(f"unexpected command 0x{command:04x}")


def names(reply):
    return [r.split(b"\0")[0].decode() for e, r in W.F.sbem_entries(reply) if e == W.POI_ENTRY]


class PoiStore(unittest.TestCase):
    def test_add_sends_only_the_new_poi(self):
        watch = FakeWatch()
        for name in ("A", "B", "C"):
            self.assertTrue(ble_pois.add_poi(watch, name, 50.6, 3.0)["ok"])
        self.assertEqual(len(watch.records), 3)
        self.assertEqual(names(W.read_pois(watch)), ["A", "B", "C"])

    def test_an_add_the_watch_did_not_keep_is_an_error(self):
        watch = FakeWatch()
        watch.command = lambda c, p=b"", **k: (b"\0\0\0\0" if c == W.CMD_POI_COUNT else b"")
        result = ble_pois.add_poi(watch, "A", 50.6, 3.0)
        self.assertFalse(result["ok"])
        self.assertIn("0 -> 0", result["error"])

    def test_a_long_accented_name_is_cut_to_what_the_watch_keeps(self):
        watch = FakeWatch()
        self.assertTrue(ble_pois.add_poi(watch, "114 Av. André Malraux", 48.84, 2.23)["ok"])
        self.assertEqual(names(W.read_pois(watch)), ["114 Av. André"])

    def test_empty_store_reads_as_nothing(self):
        self.assertEqual(W.read_pois(FakeWatch()), b"")

    def test_a_long_list_is_read_page_by_page(self):
        watch = FakeWatch(page_data=60)          # a few POIs per page
        for i in range(12):
            ble_pois.add_poi(watch, f"P{i:02d}", 50.6, 3.0)
        reply = W.read_pois(watch)
        self.assertEqual(names(reply), [f"P{i:02d}" for i in range(12)])
        self.assertGreater(watch.sent.count(W.CMD_POI_READ), 1)


if __name__ == "__main__":
    unittest.main()
