#!/usr/bin/env python3
"""Turn a Moveslink2 .sml into the raw-like fixture tools/test_sml_export.cpp reads (libambit units).

    sml_fixture_from_sml.py in.sml out.fixture

Also sanity-checks the unit assumptions the exporter relies on (latitude / longitude are radians of
integer 1e-7-degree values, speeds in 0.01 m/s ...): each must land on a whole raw number.
The .sml is the user's own file (serial number, GPS track) - it is never committed.
"""
import math, re, sys
import xml.etree.ElementTree as ET

NS = '{http://www.suunto.com/schemas/sml}'
SRC = {'Bikepod': 0, 'Footpod': 1, 'Gps': 2, 'Wrist': 3, 'Indoorswimming': 4, 'Outdoorswimming': 5}
worst = {}

def raw(name, value, scale):
    r = value / scale
    ri = round(r)
    worst[name] = max(worst.get(name, 0.0), abs(r - ri))
    return ri

def txt(e, tag, default=None):
    c = e.find(NS + tag)
    return default if c is None else (c.text or '').strip()

def dt(s):                                   # '2026-10-25T12:06:38.050Z' / '...:37Z' / '...:38' -> 6 ints
    m = re.match(r'(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)(?:\.(\d+))?', s)
    y, mo, d, h, mi, sec, frac = m.groups()
    ms = int(sec) * 1000 + (int((frac + '000')[:3]) if frac else 0)
    return [int(y), int(mo), int(d), int(h), int(mi), ms]

def main(src, dst):
    root = ET.parse(src).getroot()
    log = root.find(NS + 'DeviceLog')
    hd, dev, samples = log.find(NS + 'Header'), log.find(NS + 'Device'), log.find(NS + 'Samples')
    out = []
    f = lambda e, tag: float(txt(e, tag, '0'))
    ms = lambda v: round(v * 1000)
    out.append('DEV\t%s\t%s\t%s\t%s\t%s' % (txt(dev, 'Name'), txt(dev, 'SerialNumber'),
               txt(dev.find(NS + 'Info'), 'SW'), txt(dev.find(NS + 'Info'), 'HW'), txt(dev.find(NS + 'Info'), 'BSL')))
    swb = txt(dev.find(NS + 'Info'), 'SWBuildDateTime')
    out.append('SWBUILD\t' + ('\t'.join(map(str, dt(swb))) if swb else ''))
    sp, al, ca = hd.find(NS + 'Speed'), hd.find(NS + 'Altitude'), hd.find(NS + 'Cadence')
    out.append('HDR\t' + '\t'.join(str(x) for x in [
        *dt(txt(hd, 'DateTime')), ms(f(hd, 'Duration')), round(f(hd, 'Ascent')), round(f(hd, 'Descent')),
        ms(f(hd, 'AscentTime')), ms(f(hd, 'DescentTime')), ms(f(hd, 'RecoveryTime')),
        raw('hdr.speed_avg', f(sp, 'Avg'), 1 / 3600), raw('hdr.speed_max', f(sp, 'Max'), 1 / 3600), ms(f(sp, 'MaxTime')),
        round(f(al, 'Max')), round(f(al, 'Min')), ms(f(al, 'MaxTime')), ms(f(al, 'MinTime')),
        int(txt(hd, 'ActivityType')), round(f(hd, 'Distance')), int(txt(hd, 'LogItemCount')),
        ms(f(hd, 'TimeToFirstFix')), raw('hdr.batt0', f(hd, 'BatteryChargeAtStart'), 0.01), raw('hdr.batt1', f(hd, 'BatteryCharge'), 0.01),
        round(f(hd, 'DistanceBeforeCalibrationChange')), ms(f(ca, 'MaxTime'))]))
    out.append('NAME\t' + txt(hd, 'Activity', ''))
    base_utc_ms = None; base_ymd = None
    for s in samples:
        if txt(s, 'SampleType') == 'gps-base':
            import calendar
            u0 = dt(txt(s, 'UTC')); base_ymd = u0
            base_utc_ms = calendar.timegm((u0[0], u0[1], u0[2], u0[3], u0[4], 0)) * 1000 + u0[5] - round(float(txt(s, 'Time')) * 1000)
            break
    for s in samples:
        t = ms(float(txt(s, 'Time')))
        u = dt(txt(s, 'UTC')); U = '\t'.join(map(str, u))
        st = txt(s, 'SampleType')
        ev = s.find(NS + 'Events')
        if st == 'gps-base':
            sats = s.find(NS + 'Satellites')
            sl = []
            for x in sats:
                m = re.match(r'State (?:0x([0-9a-f]+)|(\d+))', txt(x, 'Custom'))
                sl += [int(txt(x, 'SV')), int(txt(x, 'SNR')), int(m.group(1), 16) if m.group(1) else int(m.group(2))]
            out.append('S\tgpsbase\t%d\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%s' % (
                t, U, int(txt(s, 'NavType'), 16), 0 if txt(s, 'NavValid') == 'validated' else 1,
                raw('lat', math.degrees(float(txt(s, 'Latitude'))), 1e-7), raw('lon', math.degrees(float(txt(s, 'Longitude'))), 1e-7),
                raw('gps.alt', float(txt(s, 'GPSAltitude')), 0.01), raw('gps.speed', float(txt(s, 'GPSSpeed')), 0.01),
                raw('gps.heading', math.degrees(float(txt(s, 'GPSHeading'))), 0.01), raw('gps.ehpe', float(txt(s, 'EHPE')), 0.01),
                int(txt(s, 'NumberOfSatellites')), raw('gps.hdop', float(txt(s, 'GpsHDOP')), 0.2), len(sats),
                '\t'.join(map(str, sl))))
        elif st == 'gps-small':
            # libambit gives a gps-small sample no UTC of its own: base (first gps-base) + sample time, with ms.
            # (The SML shows the watch's whole-second fix time instead; sml_export.h rounds up to match it.)
            ub = base_utc_ms + t
            U = '\t'.join(map(str, [*[base_ymd[0], base_ymd[1], base_ymd[2]], 0, 0, 0]))
            import datetime as _D
            d = _D.datetime(1970, 1, 1) + _D.timedelta(milliseconds=ub)
            U = '\t'.join(map(str, [d.year, d.month, d.day, d.hour, d.minute, d.second * 1000 + d.microsecond // 1000]))
            _u = txt(s, 'UTC')    # the watch's own second-of-minute, as utc_msec
            _sec = int(_u[17:19]) if _u and len(_u) >= 19 else 0
            out.append('S\tgpssmall\t%d\t%s\t%d\t%d\t%d\t%d\t%d' % (
                t, U, int(txt(s, 'NumberOfSatellites')), raw('lat', math.degrees(float(txt(s, 'Latitude'))), 1e-7),
                raw('lon', math.degrees(float(txt(s, 'Longitude'))), 1e-7), raw('small.ehpe', float(txt(s, 'EHPE')), 0.01), _sec * 1000))
        elif st == 'periodic':
            vals = []
            for tag, typ, sc in (('VerticalSpeed', 0x19, 0.01), ('EnergyConsumption', 0x0e, 418.68 / 60.0), ('Altitude', 0x0c, 1), ('Distance', 0x03, 1), ('Speed', 0x04, 0.01)):
                if txt(s, tag) is not None:
                    vals += [typ, raw('per.' + tag, float(txt(s, tag)), sc)]
            out.append('S\tperiodic\t%d\t%s\t%d\t%s' % (t, U, len(vals) // 2, '\t'.join(map(str, vals))))
        elif ev is not None:
            e = ev[0]; tag = e.tag.replace(NS, '')
            if tag == 'Pause':
                out.append('S\tlap\t%d\t%s\t%d\t%d\t%d' % (t, U, int(txt(e, 'Type')), ms(float(txt(e, 'Duration'))), round(float(txt(e, 'Distance')))))
            elif tag == 'Distance':
                out.append('S\tdist\t%d\t%s\t%d' % (t, U, SRC[txt(e, 'Source')]))
            elif tag == 'Activity':
                m = re.match(r'UNDEFINED(\d+)', txt(e, 'Type'))
                out.append('S\tactivity\t%d\t%s\t%d\t%d' % (t, U, int(m.group(1)), int(txt(e, 'CustomModeId'))))
            # AppStatus: not in libambit's log stream -> not part of the fixture
    # Moveslink2 writes the samples sharing the first timestamp (time 0) in the REVERSE of the watch's
    # log order, and sml_export.h reverses that group; so the fixture, which stands for what the watch
    # logs, lists that group the other way round.
    first = next((i for i, l in enumerate(out) if l.startswith('S\t')), None)
    if first is not None:
        last = first
        while last < len(out) and out[last].startswith('S\t') and out[last].split('\t')[2] == '0': last += 1
        out[first:last] = out[first:last][::-1]
    open(dst, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
    bad = {k: v for k, v in worst.items() if v > 1e-3}
    print('fixture lines:', len(out), '| max distance from a whole raw number per field:',
          {k: round(v, 6) for k, v in sorted(worst.items())})
    if bad:
        print('UNIT ASSUMPTION BROKEN for:', bad); sys.exit(2)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
