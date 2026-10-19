import type { WatchNavigation } from './RouteReader';
import type { NativeRoute } from '../native/AmbitUsbModule';

// Ambit3 / Traverse route send keeps the routes already on the watch (routes/05, desktop
// parity). The watch takes the whole navigation database in one write, so the routes read off
// it go back in the same write as the new one. Same rules as the desktop's read-back
// (tools/write_nav.py route_to_gpx):
//   - a route's own waypoints are the ones whose route name is the route's name, in rank order;
//   - each is tied to the nearest route point, searching forward from the previous one, so a
//     loop whose start and end coincide keeps its order;
//   - a route without waypoints gets a Start/End pair (the watch hides a route with none).
// A route already on the watch with the new route's name is replaced by it: the watch ties
// waypoints to routes by name, so two routes of one name would share their pins.

export const MAX_ROUTES = 50;
export const MAX_TOTAL_POINTS = 10000;
export const MAX_TOTAL_WAYPOINTS = 100;

const sameName = (a: string, b: string) => a.trim() === b.trim();

export function existingRoutesToKeep(nav: WatchNavigation, newName: string, timestampSec: number): NativeRoute[] {
  return nav.routes
    .filter(r => r.points.length >= 2 && !sameName(r.name, newName))
    .map(r => {
      const points = r.points.map(p => ({ lat: p.latitude, lon: p.longitude, alt: p.altitude }));
      const own = nav.waypoints
        .map((w, i) => ({ w, i }))
        .filter(({ w }) => sameName(w.routeName, r.name))
        .sort((a, b) => (a.w.rank ?? a.i) - (b.w.rank ?? b.i) || a.i - b.i)
        .map(({ w }) => w);
      let cursor = 0;
      const waypoints = own.map(w => {
        let best = cursor;
        let bestD = Infinity;
        for (let k = cursor; k < points.length; k++) {
          const d = (points[k].lat - w.latitude) ** 2 + (points[k].lon - w.longitude) ** 2;
          if (d < bestD) { bestD = d; best = k; }
        }
        cursor = best;
        return { lat: w.latitude, lon: w.longitude, name: w.name, pointIndex: best };
      });
      if (waypoints.length === 0) {
        const last = points.length - 1;
        waypoints.push({ lat: points[0].lat, lon: points[0].lon, name: 'Start', pointIndex: 0 },
                       { lat: points[last].lat, lon: points[last].lon, name: 'End', pointIndex: last });
      }
      return { name: r.name, points, waypoints, distanceM: r.distanceM, ascentM: r.ascentM,
               descentM: r.descentM, timestampSec };
    });
}

/** The routes to write: the ones kept, then the new one. Throws past what the watch holds. */
export function mergeRoutes(nav: WatchNavigation, route: NativeRoute): NativeRoute[] {
  const all = [...existingRoutesToKeep(nav, route.name, route.timestampSec), route];
  const points = all.reduce((n, r) => n + r.points.length, 0);
  const waypoints = all.reduce((n, r) => n + r.waypoints.length, 0);
  if (all.length > MAX_ROUTES) {
    throw new Error(`The watch holds ${MAX_ROUTES} routes; it has ${all.length - 1} already`);
  }
  if (points > MAX_TOTAL_POINTS) {
    throw new Error(`The watch holds ${MAX_TOTAL_POINTS} route points in all; this would make ${points}`);
  }
  if (waypoints > MAX_TOTAL_WAYPOINTS) {
    throw new Error(`The watch holds ${MAX_TOTAL_WAYPOINTS} route waypoints in all; this would make ${waypoints}`);
  }
  return all;
}
