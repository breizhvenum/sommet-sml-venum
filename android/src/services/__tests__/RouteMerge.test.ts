import { decodeNavigation, WatchNavigation } from '../RouteReader';
import { existingRoutesToKeep, mergeRoutes, storedName } from '../RouteMerge';
import type { NativeRoute } from '../../native/AmbitUsbModule';

// Jest runs on Node; the app's tsconfig has no Node types (the app never touches Node).
declare const require: (m: string) => any;
declare const process: { env: Record<string, string | undefined> };

// Android's Ambit3 / Traverse route send keeps the routes already on the watch (routes/05).
// The capture check runs from tools/test_route_merge.py, which hands this test the regions of
// a real SuuntoLink write (route128km, git-ignored) and what the desktop rebuilds from them.

const loop = (n: number, lat0: number) =>
  Array.from({ length: n }, (_, i) => ({ latitude: lat0 + 0.001 * Math.sin((2 * Math.PI * i) / (n - 1)),
                                         longitude: 6.9 + 0.001 * (1 - Math.cos((2 * Math.PI * i) / (n - 1))),
                                         altitude: 100 + i }));

const nav: WatchNavigation = {
  routes: [
    { name: 'Cap Roux', points: loop(21, 43.45), distanceM: 1500, ascentM: 40, descentM: 40 },
    { name: 'Dramont', points: loop(11, 43.41), distanceM: 800, ascentM: 10, descentM: 10 },
  ],
  waypoints: [
    // Table order is not route order: rank decides. Start and end of a loop coincide.
    { name: 'End', routeName: 'Cap Roux', latitude: 43.45, longitude: 6.9, rank: 2 },
    { name: 'Start', routeName: 'Cap Roux', latitude: 43.45, longitude: 6.9, rank: 0 },
    { name: 'Left 0.6', routeName: 'Cap Roux', ...(({ latitude, longitude }) => ({ latitude, longitude }))(loop(21, 43.45)[8]), rank: 1 },
    { name: 'Eiffel', routeName: '', latitude: 48.85, longitude: 2.29 },
  ],
};

const fresh: NativeRoute = {
  name: 'New one', points: [{ lat: 43.4, lon: 6.8, alt: null }, { lat: 43.41, lon: 6.81, alt: null }],
  waypoints: [{ lat: 43.4, lon: 6.8, name: 'Start', pointIndex: 0 }, { lat: 43.41, lon: 6.81, name: 'End', pointIndex: 1 }],
  distanceM: 1400, ascentM: 0, descentM: 0, timestampSec: 1_760_000_000,
};

describe('RouteMerge (Ambit3 send keeps existing routes)', () => {
  it('sends the existing routes back, then the new one', () => {
    const all = mergeRoutes(nav, fresh);
    expect(all.map(r => r.name)).toEqual(['Cap Roux', 'Dramont', 'New one']);
    expect(all[0].points).toHaveLength(21);
    expect(all[0].points[3]).toEqual({ lat: nav.routes[0].points[3].latitude, lon: nav.routes[0].points[3].longitude, alt: 103 });
    expect([all[0].distanceM, all[0].ascentM]).toEqual([1500, 40]);
  });

  it('keeps pins in rank order, tied forward so a loop ends on its last point', () => {
    const [cap] = existingRoutesToKeep(nav, 'New one', 0);
    expect(cap.waypoints.map(w => [w.name, w.pointIndex])).toEqual([['Start', 0], ['Left 0.6', 8], ['End', 20]]);
  });

  it('gives a route without pins a Start/End pair, so the watch shows it', () => {
    const dramont = existingRoutesToKeep(nav, 'New one', 0)[1];
    expect(dramont.waypoints.map(w => [w.name, w.pointIndex])).toEqual([['Start', 0], ['End', 10]]);
  });

  it('replaces a route of the same name', () => {
    const all = mergeRoutes(nav, { ...fresh, name: 'Dramont ' });
    expect(all.map(r => r.name)).toEqual(['Cap Roux', 'Dramont ']);
  });

  it('compares names as the watch stores them (15 UTF-8 bytes)', () => {
    expect(storedName('Paris-Brest-Paris 2027')).toBe('Paris-Brest-Par');
    // "î" and "ô" are 2 bytes each: 15 bytes end before the second "ô", never halfway through it.
    expect(storedName('Entraînement côte')).toBe('Entraînement c');
    const longNav: WatchNavigation = { ...nav, routes: [{ ...nav.routes[0], name: 'Paris-Brest-Par' }] };
    expect(existingRoutesToKeep(longNav, 'Paris-Brest-Paris 2027', 0)).toHaveLength(0);
  });

  it('refuses past what the watch holds', () => {
    const many: WatchNavigation = { waypoints: [], routes: Array.from({ length: 50 }, (_, i) => (
      { name: `R${i}`, points: loop(3, 43), distanceM: 1, ascentM: 0, descentM: 0 })) };
    expect(() => mergeRoutes(many, fresh)).toThrow(/50 routes/);
    const big: WatchNavigation = { waypoints: [], routes: Array.from({ length: 10 }, (_, i) => (
      { name: `R${i}`, points: loop(1000, 43), distanceM: 1, ascentM: 0, descentM: 0 })) };
    expect(() => mergeRoutes(big, fresh)).toThrow(/10000 route points/);
  });

  const fixture = process.env.ROUTE_MERGE_FIXTURE;
  (fixture ? it : it.skip)('matches the desktop on a real SuuntoLink capture', () => {
    const f = JSON.parse(require('fs').readFileSync(fixture!, 'utf8'));
    const decoded = decodeNavigation(f.waypoints, f.routes);
    const kept = existingRoutesToKeep(decoded, '', 0);
    expect(kept.map(r => ({ name: r.name, points: r.points.length,
                            // Names trimmed: the watch cuts names at 15 bytes, which can end on a
                            // space; Android sends it back as stored, the desktop's GPX step trims it.
                            waypoints: r.waypoints.map(w => [w.name.trim(), w.pointIndex]) })))
      .toEqual(f.desktop);
  });
});
