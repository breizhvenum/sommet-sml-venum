#!/usr/bin/env python3
"""The schema descriptor comes from the watch itself (0x1104), so Settings, POIs and routes work
on a machine without SuuntoLink (user report 2026-10-05; still broken on a fresh clone 2026-10-24).

A fake watch serves a small SBEM0102 dictionary in chunks; nothing touches USB.

    python3 tools/test_schema_from_watch.py
"""
import os
import pathlib
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import sbem_schema as S
import write_nav

SERIAL, FW = "8A153C5111000900", "2.4.17"
SCHEMA = S.MAGIC + b"\x01\x05Hello" + b"\x02\xff" + struct.pack("<I", 300) + bytes(300) + b"\x03\x01!"


def device_info_reply(serial=SERIAL, fw=(2, 4, 17)):
    r = bytearray(48)
    r[16:16 + len(serial)] = serial.encode()
    r[32:36] = bytes([fw[0], fw[1], fw[2] & 0xFF, fw[2] >> 8])
    return bytes(r)


class FakeWatch:
    """Answers 0x0000 (device info) and 0x1104 (schema, cursor-paged, `chunk` bytes a reply)."""
    def __init__(self, schema=SCHEMA, chunk=64, refuse=False):
        self.schema, self.chunk, self.refuse = schema, chunk, refuse
        self.sent = []
        self.opened_product_id = 0x1B

    def command(self, cmd, payload=b"", expect_reply=True, quiet=False):
        self.sent.append(cmd)
        if cmd == 0x0000:
            return device_info_reply()
        if cmd == S.CMD_DESCRIPTOR_READ:
            if self.refuse:
                raise OSError("watch refused")
            cursor, = struct.unpack("<I", payload[:4])
            part = self.schema[cursor:cursor + self.chunk]
            nxt = cursor + len(part)
            last = 1 if nxt >= len(self.schema) else 0
            return struct.pack("<I", nxt) + bytes([last, 0]) + part
        raise AssertionError(f"unexpected command 0x{cmd:04x}")


class SchemaFromWatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.saved = (S.CACHE_DIR, S.suuntolink_dirs, S.ASSETS)
        S.CACHE_DIR = root / "cache"
        S.suuntolink_dirs = lambda: [root / "Suuntolink"]
        S.ASSETS = root / "assets"
        self.root = root

    def tearDown(self):
        S.CACHE_DIR, S.suuntolink_dirs, S.ASSETS = self.saved
        self.tmp.cleanup()

    def test_read_from_the_watch_then_cached(self):
        watch = FakeWatch()
        path = S.for_link(watch)
        self.assertEqual(path, S.CACHE_DIR / f"descr+{SERIAL}+{FW}")
        self.assertEqual(path.read_bytes(), SCHEMA)
        self.assertGreater(watch.sent.count(S.CMD_DESCRIPTOR_READ), 3)     # really paged
        again = FakeWatch()
        self.assertEqual(S.for_link(again), path)
        self.assertNotIn(S.CMD_DESCRIPTOR_READ, again.sent)                # no second read

    def test_suuntolink_copy_is_used_when_present(self):
        folder = self.root / "Suuntolink"
        folder.mkdir()
        (folder / f"descr+{SERIAL}+{FW}").write_bytes(SCHEMA)
        watch = FakeWatch()
        self.assertEqual(S.for_link(watch), folder / f"descr+{SERIAL}+{FW}")
        self.assertNotIn(S.CMD_DESCRIPTOR_READ, watch.sent)

    def test_another_firmware_is_never_used(self):
        S.CACHE_DIR.mkdir(parents=True)
        (S.CACHE_DIR / f"descr+{SERIAL}+2.4.1").write_bytes(SCHEMA)
        watch = FakeWatch()
        S.for_link(watch)
        self.assertIn(S.CMD_DESCRIPTOR_READ, watch.sent)

    def test_a_half_read_is_never_cached(self):
        with self.assertRaises(RuntimeError):
            S.for_link(FakeWatch(schema=SCHEMA[:-1]))
        self.assertFalse((S.CACHE_DIR / f"descr+{SERIAL}+{FW}").exists())

    def test_a_half_cached_file_is_read_again(self):
        S.CACHE_DIR.mkdir(parents=True)
        (S.CACHE_DIR / f"descr+{SERIAL}+{FW}").write_bytes(SCHEMA[:40])
        watch = FakeWatch()
        self.assertEqual(S.for_link(watch).read_bytes(), SCHEMA)
        self.assertIn(S.CMD_DESCRIPTOR_READ, watch.sent)

    def test_watch_refuses_falls_back_to_stored_lookup(self):
        path = write_nav.schema_for_link(FakeWatch(refuse=True))
        self.assertIsInstance(path, pathlib.Path)                          # no exception


if __name__ == "__main__":
    unittest.main()
