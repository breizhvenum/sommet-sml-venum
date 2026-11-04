import React, { useEffect, useState } from 'react';
import RNFS from 'react-native-fs';
import { TrackPreview } from './TrackPreview';

// Activity card thumbnail: the track shape (a few hundred points) over the map tiles.
//
// Speed (2026-11-05, "14 activities take 30 seconds"): the old version read each activity's whole
// GPX and ran a full XML parser on it, for every card, all at once. Now:
//  - only the latitude / longitude of each <trkpt> is read (plain indexOf scans, no XML parser),
//    and the track is thinned to at most MAX_PTS points;
//  - that small track is kept on the phone (AsyncStorage), so the next time it is instant and
//    the GPX is not even opened;
//  - files are read ONE AT A TIME (a queue), so the screen stays responsive while they load.
// The data never changes for an already-synced activity, hence a permanent cache.
const MAX_PTS = 200;
const STORE_PREFIX = 'thumb_v1:';
type Pt = { lat: number; lon: number };
const mem = new Map<string, Pt[]>();

function store(): any { try { return require('@react-native-async-storage/async-storage').default; } catch (e) { return null; } }

function attr(tag: string, name: string): number {
  const k = tag.indexOf(name + '="');
  if (k < 0) return NaN;
  const a = k + name.length + 2;
  return parseFloat(tag.substring(a, tag.indexOf('"', a)));
}

/** lat / lon of every <trkpt>, thinned to MAX_PTS. */
export function quickTrack(xml: string): Pt[] {
  const all: Pt[] = [];
  let i = 0;
  for (;;) {
    const a = xml.indexOf('<trkpt', i);
    if (a < 0) break;
    const b = xml.indexOf('>', a);
    if (b < 0) break;
    const tag = xml.substring(a, b);
    i = b + 1;
    const lat = attr(tag, 'lat'), lon = attr(tag, 'lon');
    if (isFinite(lat) && isFinite(lon)) all.push({ lat, lon });
  }
  if (all.length <= MAX_PTS) return all;
  const step = (all.length - 1) / (MAX_PTS - 1);
  const out: Pt[] = [];
  for (let k = 0; k < MAX_PTS; k++) out.push(all[Math.round(k * step)]);
  return out;
}

// One file at a time.
let queue: Promise<unknown> = Promise.resolve();
function load(path: string): Promise<Pt[]> {
  const job = queue.then(async () => {
    if (mem.has(path)) return mem.get(path)!;
    try {
      const st = store();
      if (st) {
        const v = await st.getItem(STORE_PREFIX + path);
        if (v) { const p = JSON.parse(v) as Pt[]; mem.set(path, p); return p; }
      }
    } catch (e) { /* not kept: recomputed below */ }
    let pts: Pt[] = [];
    try { pts = quickTrack(await RNFS.readFile(path, 'utf8')); } catch (e) { pts = []; }
    mem.set(path, pts);
    if (pts.length) { try { const st = store(); if (st) await st.setItem(STORE_PREFIX + path, JSON.stringify(pts)); } catch (e) { /* ignore */ } }
    return pts;
  });
  queue = job.catch(() => undefined);
  return job;
}

export function ActivityThumbnail({ gpxPath, height = 90 }: { gpxPath: string; height?: number }) {
  const [points, setPoints] = useState<Pt[] | null>(mem.get(gpxPath) ?? null);

  useEffect(() => {
    if (mem.has(gpxPath)) { setPoints(mem.get(gpxPath)!); return; }
    let cancelled = false;
    load(gpxPath).then(p => { if (!cancelled) setPoints(p); }).catch(() => { if (!cancelled) setPoints([]); });
    return () => { cancelled = true; };
  }, [gpxPath]);

  if (points === null) return null;
  return <TrackPreview points={points} height={height} />;
}
