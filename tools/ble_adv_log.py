#!/usr/bin/env python3
"""Passive Bluetooth LE advertisement logger.

Listens only. It never connects, never pairs, never writes. Use it to find out what a new
device (a scale, a sensor) sends by itself, so a decoder can be written from real bytes.

    tools/ble_adv_log.py scan --seconds 60 --out scale.jsonl
    tools/ble_adv_log.py scan --name etek --seconds 120 --out scale.jsonl
    tools/ble_adv_log.py scan --address AA:BB:CC:DD:EE:FF
    tools/ble_adv_log.py show scale.jsonl          # summary of an earlier capture
    tools/ble_adv_log.py selftest                  # needs no Bluetooth

A line is printed (and written to --out as one JSON object) the first time a device sends a
given payload, and again if it comes back after 20 seconds. A scale that broadcasts its weight changes its payload while you step on it, so the
devices at the top of the closing summary are the ones whose bytes moved the most.

Needs: pip install bleak
"""
import argparse
import asyncio
import json
import sys
import time


REPEAT_AFTER = 20.0   # seconds before an identical payload is logged again


def hexs(b):
    return bytes(b).hex()


def payload_key(rec):
    """What counts as 'changed': the data fields, not the signal strength."""
    return (rec["name"], tuple(sorted(rec["mfr"].items())), tuple(sorted(rec["svc"].items())),
            tuple(rec["uuids"]))


def record(address, name, rssi, adv, now=None):
    """One plain dict from a bleak advertisement (or anything shaped like one)."""
    return {
        "t": round(now if now is not None else time.time(), 3),
        "address": address,
        "name": name or getattr(adv, "local_name", None) or "",
        "rssi": rssi,
        "mfr": {f"{k:04x}": hexs(v) for k, v in (getattr(adv, "manufacturer_data", None) or {}).items()},
        "svc": {str(k): hexs(v) for k, v in (getattr(adv, "service_data", None) or {}).items()},
        "uuids": sorted(getattr(adv, "service_uuids", None) or []),
        "tx": getattr(adv, "tx_power", None),
    }


class Collector:
    def __init__(self, name=None, address=None, out=None, echo=print):
        self.name = name.lower() if name else None
        self.address = address.upper() if address else None
        self.out = out
        self.echo = echo
        self.seen = {}      # (address, payload_key) -> time it was last logged
        self.changes = {}   # address -> number of distinct payloads seen
        self.names = {}
        self.rssi = {}

    def wanted(self, rec):
        if self.address and rec["address"].upper() != self.address:
            return False
        if self.name and self.name not in rec["name"].lower():
            return False
        return True

    def feed(self, rec):
        if not self.wanted(rec):
            return False
        a = rec["address"]
        if rec["name"]:
            self.names[a] = rec["name"]
        self.rssi[a] = rec["rssi"]
        key = (a, payload_key(rec))
        # Quiet for a payload already logged, unless it comes back after a while (the same
        # weight twice). Phones that alternate between two payloads stay quiet this way.
        if key in self.seen and rec["t"] - self.seen[key] < REPEAT_AFTER:
            return False
        self.seen[key] = rec["t"]
        self.changes[a] = self.changes.get(a, 0) + 1
        if self.out:
            self.out.write(json.dumps(rec) + "\n")
            self.out.flush()
        parts = [f"{a}", f"{self.names.get(a, '?')!s:<16}", f"rssi={rec['rssi']}"]
        for k, v in rec["mfr"].items():
            parts.append(f"mfr[{k}]={v}")
        for k, v in rec["svc"].items():
            parts.append(f"svc[{k[4:8] if len(k) > 8 else k}]={v}")
        if rec["uuids"]:
            parts.append("uuids=" + ",".join(u[4:8] if len(u) > 8 else u for u in rec["uuids"]))
        self.echo("  ".join(parts))
        return True

    def summary(self):
        rows = sorted(self.changes, key=lambda a: -self.changes[a])
        lines = ["", "devices by how often their payload changed:"]
        for a in rows:
            lines.append(f"  {self.changes[a]:5d}  {a}  {self.names.get(a, '?')}  rssi={self.rssi.get(a)}")
        if not rows:
            lines.append("  (nothing heard)")
        return "\n".join(lines)


async def scan(args):
    try:
        from bleak import BleakScanner
    except ImportError:
        sys.exit("bleak is not installed: pip install bleak")
    out = open(args.out, "a", encoding="utf-8") if args.out else None
    col = Collector(args.name, args.address, out)

    def on_adv(device, adv):
        col.feed(record(device.address, device.name, adv.rssi, adv))

    print(f"Listening {args.seconds}s (passive, nothing is sent). "
          f"Step on the scale now and again every ~15 s.")
    async with BleakScanner(on_adv):
        try:
            await asyncio.sleep(args.seconds)
        except asyncio.CancelledError:
            pass
    print(col.summary())
    if out:
        out.close()
        print(f"\nraw capture: {args.out}")


def show(args):
    col = Collector(args.name, args.address, echo=lambda s: None)
    with open(args.file, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                col.feed(json.loads(line))
    print(col.summary())


def selftest():
    class Adv:
        def __init__(self, mfr=None, svc=None, uuids=None, name=None):
            self.manufacturer_data = mfr or {}
            self.service_data = svc or {}
            self.service_uuids = uuids or []
            self.local_name = name
            self.tx_power = None

    seen = []
    col = Collector(echo=seen.append)
    r = lambda addr, mfr, name="": record(addr, name, -60, Adv(mfr=mfr, name=name), 1.0)
    assert col.feed(r("AA", {0x0100: b"\x01\x02"}, "scale")) is True
    assert col.feed(r("AA", {0x0100: b"\x01\x02"}, "scale")) is False, "same payload is quiet"
    assert col.feed(r("AA", {0x0100: b"\x01\x03"}, "scale")) is True, "changed payload is logged"
    assert col.feed(r("AA", {0x0100: b"\x01\x02"}, "scale")) is False, "alternating is quiet"
    assert col.feed(r("BB", {}, "other")) is True
    assert col.changes == {"AA": 2, "BB": 1}
    assert col.summary().splitlines()[2].split()[1] == "AA", "most-changing device first"
    only = Collector(name="SCA", echo=seen.append)
    assert only.feed(r("CC", {}, "My Scale")) is True
    assert only.feed(r("DD", {}, "Watch")) is False, "name filter"
    adr = Collector(address="ee:ff", echo=seen.append)
    assert adr.feed(r("EE:FF", {}, "x")) is True and adr.feed(r("11:22", {}, "x")) is False
    rec = r("AA", {0x0100: b"\xab"}, "scale")
    assert json.loads(json.dumps(rec))["mfr"] == {"0100": "ab"}
    print("selftest ok")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan", help="listen for advertisements")
    s.add_argument("--seconds", type=float, default=60)
    s.add_argument("--name", help="only devices whose name contains this")
    s.add_argument("--address", help="only this address")
    s.add_argument("--out", help="append raw capture here as JSON lines")
    w = sub.add_parser("show", help="summarise a saved capture")
    w.add_argument("file")
    w.add_argument("--name")
    w.add_argument("--address")
    sub.add_parser("selftest")
    args = p.parse_args()
    if args.cmd == "selftest":
        selftest()
    elif args.cmd == "show":
        show(args)
    else:
        try:
            asyncio.run(scan(args))
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
