#!/usr/bin/env python3
"""Ambit1/2 route send, without a watch.

Ground truth: André's Ambit1 SuuntoLink capture (assets/pcap/2026-08-23-ambit1-suuntolink/
zzambit1full.pcap, git-ignored - skipped where it is absent). It holds the route region SuuntoLink
wrote and the 0x0b05 packets of each route's waypoints. Checked here:
  - a route waypoint packs to the exact 0x0b05 bytes SuuntoLink sent (rank in the seconds);
  - route_send() keeps the existing routes byte for byte and adds the new one after them;
  - the waypoint list it writes back is the old list plus the new route's pins, in rank order.
The write itself (flash-write + waypoints-restore) is the path proven on an Ambit1 and an Ambit2
on 2026-08-27 (backup/restore); a route SENT this way has not been seen on a watch yet.
"""
import json
import pathlib
import struct
import sys
import tempfile

import legacy_link
import legacy_route
import route_pins

ROOT = pathlib.Path(__file__).resolve().parent.parent
CAPTURE = ROOT / "assets" / "pcap" / "2026-08-23-ambit1-suuntolink" / "zzambit1full.pcap"


def _capture():
    import ambit_pcap
    msgs = ambit_pcap.messages(CAPTURE)
    buf, end = bytearray(0x20000), 0
    for m in msgs:
        if m.command == 0x0B16 and not m.incoming:
            addr, length, _ = struct.unpack("<IHH", m.payload[:8])
            off = addr - legacy_route.ROUTE_REGION_ADDR
            if 0 <= off < len(buf):     # placed at its address: the table/points gap is real
                buf[off:off + length] = m.payload[8:8 + length]
                end = max(end, off + length)
    packets = [m.payload for m in msgs if m.command == 0x0B05 and not m.incoming]
    return bytes(buf[:end]), packets


def _cli_packet(rec):
    """What ambit_legacy_cli's waypoints-restore sends for one 48-byte record (its C, mirrored)."""
    p = bytearray(55)
    p[4:20] = rec[0:16]
    p[19] = 0
    p[20:36] = rec[16:32]
    p[35] = 0
    p[36], p[37], p[38], p[39], p[40] = rec[47], rec[46], rec[45], rec[44], rec[43]
    p[41:43] = rec[41:43]
    p[43:47] = rec[32:36]
    p[47:51] = rec[36:40]
    p[51] = rec[40]
    return bytes(p)


def test_route_waypoint_packet_matches_suuntolink(packets):
    # "Grand Tour HDF " waypoints 0..8, as SuuntoLink sent them.
    grand = [p for p in packets if p[20:35] == b"Grand Tour HDF "][:9]
    assert len(grand) == 9
    pts = [(struct.unpack_from("<i", p, 43)[0] / 1e7, struct.unpack_from("<i", p, 47)[0] / 1e7,
            p[4:20].split(b"\0")[0].decode("latin-1")) for p in grand]
    ours = legacy_route.route_waypoints("Grand Tour HDF ", pts)
    blob = legacy_link._encode_waypoints(ours)
    for i, want in enumerate(grand):
        got = _cli_packet(blob[48 * i:48 * (i + 1)])
        # byte 53: the CLI sets the name length there, SuuntoLink leaves 0 - the only difference,
        # and the one the CLI's waypoint restore was proven with on both watches.
        assert got[:53] == want[:53] and got[54:] == want[54:], (i, got.hex(" "), want.hex(" "))


def test_route_send_keeps_and_adds(region, packets):
    pois = [{"name": "Eiffel Tower", "lat": 48.8582, "lon": 2.2945, "type": 0, "route_name": ""}]
    sent = {}
    legacy_link.read_route_region = lambda: region
    legacy_link.waypoints = lambda: {"ok": True, "waypoints": pois}
    legacy_link.restore_route_region = lambda data: sent.setdefault("region", data)
    legacy_link.waypoints_restore = lambda wps: sent.setdefault("list", wps)

    res = route_pins.build(route_pins._synthetic(route_pins.TEST_WALK), target="ambit", name="Pins walk")
    with tempfile.TemporaryDirectory() as tmp:
        gpx = pathlib.Path(tmp) / "walk.gpx"
        gpx.write_text(res["gpx"])
        dry = legacy_link.route_send([gpx])
        assert dry["ok"] and not dry["wrote"] and not sent, dry
        out = legacy_link.route_send([gpx], write=True, backup_dir=tmp)
        assert out["wrote"] and json.loads(pathlib.Path(out["backup"]).read_text())["waypoints"] == pois

    old = legacy_route.parse(region)
    new = legacy_route.parse(sent["region"])
    assert [r["name"] for r in new["routes"]] == [r["name"] for r in old["routes"]] + ["Pins walk"]
    n_old = old["routepoint_count"]
    po = legacy_route.POINTS_OFFSET
    assert sent["region"][po:po + 8 * n_old] == region[po:po + 8 * n_old]       # untouched
    added = sent["list"][len(pois):]
    assert sent["list"][:len(pois)] == pois
    assert [w["ctime_second"] for w in added] == list(range(len(added)))
    assert all(w["route_name"] == "Pins walk" and w["type"] == 17 for w in added)
    assert any(w["name"].startswith("Turn back") for w in added), [w["name"] for w in added]


def test_limits():
    big = [{"name": "x", "points": [(0.0, i * 1e-4) for i in range(1001)], "distance_m": 1}]
    try:
        legacy_route.append(None, big)
        raise AssertionError("1001 points accepted")
    except ValueError:
        pass


if __name__ == "__main__":
    test_limits()
    if not CAPTURE.exists():
        print("legacy route send: limits OK; capture absent, rest skipped")
        sys.exit(0)
    region, packets = _capture()
    test_route_waypoint_packet_matches_suuntolink(packets)
    test_route_send_keeps_and_adds(region, packets)
    print("legacy route send: packets match SuuntoLink, routes kept, pins added")
