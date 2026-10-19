import { Buffer } from 'buffer';
import { appendLegacyRoutes, legacyRouteWaypoints, parseRoutes, POINTS_OFFSET } from '../LegacyRoute';

// Parity with tools/legacy_route.py append(): the same two routes must give the same bytes.
// Reference: tools/legacy_route.py append(append(None, [a]), [b]) with these same inputs (the
// Python lists hold (lat, lon) tuples; distance_m 5210 / 2400) -> 2952 bytes, FNV-1a below.
const a = { name: 'Cap Roux loop', distanceM: 5210,
  points: Array.from({ length: 40 }, (_, i) => ({ lat: 43.4521 + 0.0011 * Math.sin(i / 3), lon: 6.8803 + 0.0013 * i })) };
const b = { name: 'Dramont', distanceM: 2400,
  points: Array.from({ length: 25 }, (_, i) => ({ lat: 43.41 + 0.0007 * i, lon: 6.85 - 0.0009 * Math.cos(i / 2) })) };

describe('LegacyRoute building (Ambit1/2 route send)', () => {
  it('matches the Python builder byte for byte', () => {
    const r2 = appendLegacyRoutes(appendLegacyRoutes(null, [a]), [b]);
    expect(r2.length).toBe(2952);
    let h = 0x811c9dc5;                       // FNV-1a 32, same loop run on the Python bytes
    for (const x of r2) h = Math.imul(h ^ x, 0x01000193) >>> 0;
    expect(h).toBe(0x2061018f);
  });

  it('keeps existing routes byte for byte and decodes the new one', () => {
    const r1 = appendLegacyRoutes(null, [a]);
    const r2 = appendLegacyRoutes(r1, [b]);
    expect(Buffer.from(r2.subarray(POINTS_OFFSET, POINTS_OFFSET + 8 * 40)))
      .toEqual(Buffer.from(r1.subarray(POINTS_OFFSET, POINTS_OFFSET + 8 * 40)));
    const routes = parseRoutes(Buffer.from(r2).toString('base64'));
    expect(routes.map((r) => r.name)).toEqual(['Cap Roux loop', 'Dramont']);
    expect(routes[1].points[3].latitude).toBeCloseTo(43.4121, 4);
  });

  it('refuses past the watch room', () => {
    const big = { name: 'x', distanceM: 1, points: Array.from({ length: 1001 }, (_, i) => ({ lat: 0, lon: i * 1e-4 })) };
    expect(() => appendLegacyRoutes(null, [big])).toThrow(/1000 per route/);
  });

  it('ranks route waypoints in the seconds, as SuuntoLink does', () => {
    const w = legacyRouteWaypoints('Cap Roux loop', [
      { lat: 43.45, lon: 6.88, name: 'Start' }, { lat: 43.46, lon: 6.89, name: 'Left 1.2' }]);
    expect(w.map((x) => [x.ctime_year, x.ctime_second, x.type, x.routeName]))
      .toEqual([[1970, 0, 17, 'Cap Roux loop'], [1970, 1, 17, 'Cap Roux loop']]);
  });
});
