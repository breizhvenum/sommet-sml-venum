#!/usr/bin/env python3
"""Reads weigh-ins from an Etekcity-style Bluetooth body-fat scale that broadcasts its
weight (company id 0x06d0, service 0xffd0). Listens only: no pairing, no app, no account.

    tools/etekcity_scale.py listen                       # print each finished weigh-in
    tools/etekcity_scale.py listen --log weighins.jsonl  # also append them as JSON lines
    tools/etekcity_scale.py decode HEX                   # decode one 20-byte payload
    tools/etekcity_scale.py selftest

Layout of the 20-byte manufacturer data, read from real captures (2026-10-15) and checked
against the scale's display (the raw 0.001 kg value is shown rounded to 0.05 kg):

    0        0x01
    1..6     the scale's own address, reversed
    7..9     c0 a9 01 (constant in every capture)
    10..12   weight, 3 bytes little-endian, 0.001 kg. Ramps while stepping on, then settles.
    13..14   on the final packet: u16 little-endian, within a few ohms across weigh-ins. Looks like
             impedance in ohms (not yet confirmed; needs shoes-on / shoes-off comparison).
             Zero while the weight is still ramping.
    15       0x01 on the final packet (reading finished), 0x00 while ramping
    16..19   00 02 03 00 (constant)
"""
import argparse
import asyncio
import json
import sys
import time

COMPANY_ID = 0x06D0
SERVICE_UUID = "0000ffd0-0000-1000-8000-00805f9b34fb"


def decode(data):
    """A dict for one broadcast payload, or None if it is not this scale's format."""
    b = bytes(data)
    if len(b) != 20 or b[0] != 0x01:
        return None
    imp = int.from_bytes(b[13:15], "little")
    final = b[15] == 0x01
    return {
        "address": ":".join(f"{x:02X}" for x in reversed(b[1:7])),
        "weight_kg": int.from_bytes(b[10:13], "little") / 1000.0,
        "impedance_ohm": imp if final and imp else None,
        "final": final,
    }


class Settle:
    """Turns the stream of packets into one result per weigh-in. The scale repeats its final
    packet while you stand there, and it can re-measure (impedance 0, then back) without you
    stepping off. Measured 2026-10-16: a real step-on starts from about 0 kg or follows a long
    silence; a re-measure keeps the weight up with pauses of 3-7 s. So a final packet is a
    new weigh-in only after a near-zero weight packet or `silence` seconds without any packet."""

    NEAR_ZERO_KG = 5.0

    def __init__(self, silence=15.0):
        self.silence = silence
        self.last_t = None
        self.armed = True     # True: the next final packet counts as a weigh-in

    def feed(self, d, now):
        if not d:
            return None
        if self.last_t is not None and now - self.last_t >= self.silence:
            self.armed = True
        self.last_t = now
        if not d["final"]:
            if d["weight_kg"] < self.NEAR_ZERO_KG:
                self.armed = True
            return None
        fresh = self.armed
        self.armed = False
        return d if fresh else None


# Payloads shaped like the first real capture (made-up address and weight): a ramp, the settled
# packet, and repeats.
_SAMPLES = [
    ("01010000eeffc0c0a901f4790000000000020300", 31.22, False, None),
    ("01010000eeffc0c0a90172230100000000020300", 74.61, False, None),
    ("01010000eeffc0c0a901722301f4010100020300", 74.61, True, 500),
    ("01010000eeffc0c0a901722301f3010100020300", 74.61, True, 499),
    ("01010000eeffc0c0a901722301f6010100020300", 74.61, True, 502),
]


def selftest():
    for hx, kg, final, imp in _SAMPLES:
        d = decode(bytes.fromhex(hx))
        assert d["address"] == "C0:FF:EE:00:00:01", d
        assert abs(d["weight_kg"] - kg) < 1e-9, (hx, d)
        assert d["final"] is final and d["impedance_ohm"] == imp, (hx, d)
    assert decode(b"\x00" * 20) is None and decode(b"\x01\x02") is None
    s = Settle(silence=15)
    fin = decode(bytes.fromhex(_SAMPLES[2][0]))
    ramp = decode(bytes.fromhex(_SAMPLES[1][0]))
    zero = decode(bytes.fromhex(_SAMPLES[1][0])[:10] + bytes(3) + bytes.fromhex(_SAMPLES[1][0])[13:])
    assert zero["weight_kg"] == 0.0 and not zero["final"], zero
    assert s.feed(ramp, 0) is None, "ramp is ignored"
    assert s.feed(fin, 5.5) is fin, "first final packet is the weigh-in"
    assert s.feed(fin, 8.0) is None, "repeat while standing there is not a new weigh-in"
    assert s.feed(ramp, 14.0) is None and s.feed(fin, 15.0) is None, \
        "re-measure while standing still (weight stays high) is not a new weigh-in"
    assert s.feed(fin, 40.0) is fin, "after 15 s of silence it is a new weigh-in"
    assert s.feed(zero, 41.0) is None and s.feed(ramp, 42.0) is None
    assert s.feed(fin, 43.0) is fin, "stepping off (weight back to ~0) then on again is a new weigh-in"
    print("selftest ok")


async def listen(args):
    try:
        from bleak import BleakScanner
    except ImportError:
        sys.exit("bleak is not installed: pip install bleak")
    settle = Settle()
    log = open(args.log, "a", encoding="utf-8") if args.log else None
    raw_log = open(args.log + ".raw", "a", encoding="utf-8") if args.log else None
    addr = args.address.upper() if args.address else None

    def on_adv(device, adv):
        raw = (adv.manufacturer_data or {}).get(COMPANY_ID)
        d = decode(raw) if raw is not None else None
        if d is None or (addr and d["address"] != addr):
            return
        if raw_log:
            raw_log.write(json.dumps({"t": time.time(), "hex": raw.hex()}) + "\n")
            raw_log.flush()
        res = settle.feed(d, time.time())
        if res:
            res = dict(res, t=int(time.time()))
            imp = f"  impedance {res['impedance_ohm']} ohm" if res["impedance_ohm"] else ""
            print(f"{time.strftime('%H:%M:%S')}  {res['weight_kg']:.2f} kg{imp}", flush=True)
            if log:
                log.write(json.dumps(res) + "\n")
                log.flush()

    print("Listening for the scale (passive). Step on it. Ctrl-C to stop.", flush=True)
    async with BleakScanner(on_adv):
        await asyncio.sleep(args.seconds if args.seconds else 10 ** 9)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    l = sub.add_parser("listen")
    l.add_argument("--log")
    l.add_argument("--address", help="only this scale")
    l.add_argument("--seconds", type=float, default=0, help="stop after this long (default: run until Ctrl-C)")
    d = sub.add_parser("decode")
    d.add_argument("hex")
    sub.add_parser("selftest")
    a = p.parse_args()
    if a.cmd == "selftest":
        selftest()
    elif a.cmd == "decode":
        print(decode(bytes.fromhex(a.hex.replace(" ", ""))))
    else:
        try:
            asyncio.run(listen(a))
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
