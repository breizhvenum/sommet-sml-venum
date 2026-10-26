import AsyncStorage from '@react-native-async-storage/async-storage';
import { base64ToBytes } from './Base64';
import { getDeviceInfo, readObjectRaw } from '../native/AmbitUsbModule';

// The Ambit3's own daily step counts (2026-10-18). Port of the desktop's tools/ambit_steps.py:
// the watch keeps 30 daily counts in sml.DeviceHistory, oldest first, the last one being today
// so far, read with the 0x1200 object query (id 0x97 on fw 2.4.17). Read from André's Peak over
// USB on 2026-10-18; the field ids come from the watch's own schema descriptor:
//   0x12e  LastDays.Steps   30 x u32, 0xFFFFFFFF = no count that day   (long-id entry)
//   0x130  DeviceHistory.Timestamp  "2026-10-18T13:06:02+03:00"         (long-id entry)
// Entries with an id of 0xff or more are written [ff][u16 id][len][data].
// The timestamp's date is the date of the last slot. Its "+03:00" is not the watch's real zone
// (André's Peak sent 14:19+03:00 at 14:19 CEST), so only the date is used.

//
// The same reply carries the watch's "Activity" display (ActivityTracking; layout from the
// firmware, ring descriptors 0x706d4.., checked on André's Peak 2026-10-20 - see
// tools/ambit_steps.py):
//   0x92  DailyRecovery   96 x u16, one per 15 min (last 24 h), oldest first, unit 22.5 min
//   0x93  DailyActivity   96 x u16 kcal, one per 15 min since midnight, cumulative
//   0x94  WeeklyActivity   7 x u16 kcal, one per day, the last one = today so far
// Samples fall on the quarter hours; the newest is the last one at or before the timestamp.

export const DEVICE_HISTORY_QUERY = 0x97;
const RECOVERY_ID = 0x92;
const WEEKLY_ACTIVITY_ID = 0x94;
const RECOVERY_UNIT_H = 22.5 / 60;
const ACTIVITY_KEY = 'health.watchActivity';
const RECOVERY_KEY = 'health.watchRecovery';
const STEPS_ID = 0x12e;
const TIMESTAMP_ID = 0x130;
const DAYS = 30;
const NO_COUNT = 0xffffffff;
const STORE_KEY = 'health.watchSteps';
// Each watch's own days, kept apart: {watch serial: {date: value}} (see storeByWatch).
const STEPS_BY_WATCH_KEY = 'health.watchStepsByWatch';
const ACTIVITY_BY_WATCH_KEY = 'health.watchActivityByWatch';
const RECOVERY_BY_WATCH_KEY = 'health.watchRecoveryByWatch';
// Ambit3 Peak, Sport, Run, Vertical (the model name the watch itself reports). The Kailash,
// Traverse and Ambit1/2 number their fields differently or keep no daily steps.
const AMBIT3_MODELS = ['emu', 'finch', 'ibisbill', 'kaka'];

export interface StepsDay { date: string; steps: number; today: boolean }
export interface ActivityDay { date: string; kcal: number; today: boolean }
/** Recovery time at the watch's newest quarter-hour sample (`time`, watch local clock,
 *  "YYYY-MM-DDTHH:MM"), and its peak over the `spanHours` the watch kept. */
export interface WatchRecovery { time: string; hours: number; peak: number; spanHours: number }
export interface WatchSteps {
  timestamp: string;
  days: StepsDay[];
  activity: ActivityDay[];
  recovery: WatchRecovery | null;
}

const MAGIC = [0x53, 0x42, 0x45, 0x4d, 0x30, 0x31, 0x30, 0x32]; // "SBEM0102"

function findMagic(b: Uint8Array): number {
  for (let i = 0; i + MAGIC.length <= b.length; i++) {
    let ok = true;
    for (let j = 0; j < MAGIC.length; j++) if (b[i + j] !== MAGIC[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/** [id, start, end] of each SBEM entry after the magic, long ids included. */
export function sbemEntries(b: Uint8Array, magicAt: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let off = magicAt + 8;
  while (off + 2 <= b.length) {
    let id = b[off++];
    if (id === 0xff) {
      if (off + 3 > b.length) break;
      id = b[off] | (b[off + 1] << 8);
      off += 2;
    }
    let len = b[off++];
    if (len === 0xff) {
      if (off + 4 > b.length) break;
      len = (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
      off += 4;
    }
    if (off + len > b.length) break;
    out.push([id, off, off + len]);
    off += len;
  }
  return out;
}

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function addDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return t.toISOString().slice(0, 10);
}

/** Decodes the raw 0x1200 DeviceHistory reply. Null when it is not the expected layout (a
 *  firmware with another numbering), never a wrong number. */
export function decodeWatchSteps(b64: string): WatchSteps | null {
  const b = base64ToBytes(b64);
  const at = findMagic(b);
  if (at < 6) return null;
  // [u32 cursor][u16 last]: a reply that continues on another page is not handled here.
  if (u32(b, at - 6) !== 0) return null;
  let steps: [number, number] | null = null;
  let stamp = '';
  const u16s: Record<number, number[]> = { [RECOVERY_ID]: [], [WEEKLY_ACTIVITY_ID]: [] };
  for (const [id, s, e] of sbemEntries(b, at)) {
    if (u16s[id]) for (let o = s; o + 2 <= e; o += 2) u16s[id].push(b[o] | (b[o + 1] << 8));
    if (id === STEPS_ID && steps === null) steps = [s, e];
    if (id === TIMESTAMP_ID && !stamp) {
      let end = s;
      while (end < e && b[end] !== 0) end++;
      stamp = String.fromCharCode(...Array.from(b.subarray(s, end)));
    }
  }
  if (!steps || steps[1] - steps[0] !== DAYS * 4) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(stamp);
  if (!m) return null;
  const today = m[1];
  const days: StepsDay[] = [];
  for (let i = 0; i < DAYS; i++) {
    const n = u32(b, steps[0] + i * 4);
    if (n === NO_COUNT) continue;
    days.push({ date: addDays(today, i - (DAYS - 1)), steps: n, today: i === DAYS - 1 });
  }
  const week = u16s[WEEKLY_ACTIVITY_ID];
  const activity = week.map((kcal, i) => ({
    date: addDays(today, i - (week.length - 1)), kcal, today: i === week.length - 1,
  }));
  const rec = u16s[RECOVERY_ID];
  let recovery: WatchRecovery | null = null;
  if (rec.length > 0) {
    const quarter = Math.floor(Number(m[3]) / 15) * 15;
    const hours = (v: number) => Math.round(v * RECOVERY_UNIT_H * 100) / 100;
    recovery = {
      time: `${today}T${m[2]}:${String(quarter).padStart(2, '0')}`,
      hours: hours(rec[rec.length - 1]),
      peak: hours(Math.max(...rec)),
      spanHours: rec.length / 4,
    };
  }
  return { timestamp: stamp, days, activity, recovery };
}

/** Every day Sommet has read from the watch, oldest first: [{date, steps}]. Kept beyond the
 *  watch's own 30 days. */
export async function loadWatchSteps(): Promise<Array<{ date: string; steps: number }>> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((e: any) => e && typeof e.date === 'string' && typeof e.steps === 'number');
  } catch {
    return [];
  }
}

export type ByWatch = Record<string, Record<string, number>>;

async function readJson(key: string): Promise<any> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Each watch's own days, kept apart at `byKey` (André, 2026-10-26: "it should import from any,
 *  so we can merge"). The list Health shows (`mergedKey`, [{date, <field>}]) takes, per day, the
 *  highest value any watch has: a watch left on the desk reports 0 for a day the one on the
 *  wrist counted and must not erase it, and two watches worn together aren't counted twice. A
 *  newer read of a day replaces that watch's older one (today's count grows). The list kept
 *  before watches were told apart stays, as "earlier". Same rule as the desktop's
 *  ActivityService storeByWatch(). */
async function storeByWatch(byKey: string, mergedKey: string, field: 'steps' | 'kcal',
                            watch: string, days: Array<{ date: string; value: number }>): Promise<ByWatch> {
  const stored = await readJson(byKey);
  const all: ByWatch = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  if (!stored) {
    const earlier: Record<string, number> = {};
    const list = await readJson(mergedKey);
    if (Array.isArray(list)) {
      for (const e of list) {
        if (e && typeof e.date === 'string' && typeof e[field] === 'number') earlier[e.date] = e[field];
      }
    }
    if (Object.keys(earlier).length > 0) all.earlier = earlier;
  }
  const mine = { ...(all[watch] ?? {}) };
  for (const d of days) mine[d.date] = d.value;
  all[watch] = mine;
  await AsyncStorage.setItem(byKey, JSON.stringify(all));

  const merged = new Map<string, number>();
  for (const perDay of Object.values(all)) {
    for (const [date, v] of Object.entries(perDay ?? {})) {
      if (typeof v === 'number' && (!merged.has(date) || v > merged.get(date)!)) merged.set(date, v);
    }
  }
  const list = Array.from(merged.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, value]) => ({ date, [field]: value }));
  await AsyncStorage.setItem(mergedKey, JSON.stringify(list));
  return all;
}

/** Stores one watch's read of its daily steps; returns every watch's days. */
export async function mergeWatchSteps(days: StepsDay[], watch = 'watch'): Promise<ByWatch> {
  return storeByWatch(STEPS_BY_WATCH_KEY, STORE_KEY, 'steps', watch,
                      days.map(d => ({ date: d.date, value: d.steps })));
}

/** Every day of watch activity Sommet has read, oldest first: [{date, kcal}]. */
export async function loadWatchActivity(): Promise<Array<{ date: string; kcal: number }>> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVITY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.filter((e: any) => e && typeof e.date === 'string' && typeof e.kcal === 'number');
  } catch {
    return [];
  }
}

/** The recovery time at the last watch read, or null. */
export async function loadWatchRecovery(): Promise<WatchRecovery | null> {
  try {
    const raw = await AsyncStorage.getItem(RECOVERY_KEY);
    const r = raw ? JSON.parse(raw) : null;
    return r && typeof r.hours === 'number' && typeof r.time === 'string' ? r : null;
  } catch {
    return null;
  }
}

/** Stores one watch's read of its activity days and its recovery snapshot. Health shows the
 *  snapshot of the watch with the most steps on the snapshot's day - the one that was worn, not
 *  one left on the desk at 0 h - and the newest on a tie. */
export async function mergeWatchActivity(decoded: WatchSteps, watch = 'watch',
                                         stepsByWatch?: ByWatch): Promise<void> {
  await storeByWatch(ACTIVITY_BY_WATCH_KEY, ACTIVITY_KEY, 'kcal', watch,
                     decoded.activity.map(d => ({ date: d.date, value: d.kcal })));
  const stored = await readJson(RECOVERY_BY_WATCH_KEY);
  const snaps: Record<string, WatchRecovery> =
    stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  if (decoded.recovery) {
    snaps[watch] = decoded.recovery;
    await AsyncStorage.setItem(RECOVERY_BY_WATCH_KEY, JSON.stringify(snaps));
  }
  const steps: ByWatch = stepsByWatch ?? ((await readJson(STEPS_BY_WATCH_KEY)) || {});
  let best: WatchRecovery | null = null;
  let bestSteps = -1;
  for (const [w, snap] of Object.entries(snaps)) {
    if (!snap || typeof snap.time !== 'string') continue;
    const daySteps = steps[w]?.[snap.time.slice(0, 10)] ?? 0;
    if (daySteps > bestSteps || (daySteps === bestSteps && best && snap.time > best.time)) {
      best = snap;
      bestSteps = daySteps;
    }
  }
  if (best) await AsyncStorage.setItem(RECOVERY_KEY, JSON.stringify(best));
}

/** The watch's activity kcal from Monday to `now`'s day (André, 2026-10-26: "how much activity
 *  you did this week"), over the merged days. `from` = that Monday, `days` = days with a value. */
export function weekActivity(kcal: Array<{ date: string; kcal?: number }>, now = new Date()):
    { kcal: number; days: number; from: string } {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now);
  const from = addDays(today, -((now.getDay() + 6) % 7));
  let total = 0;
  let days = 0;
  for (const e of kcal) {
    if (typeof e.kcal === 'number' && e.date >= from && e.date <= today) {
      total += e.kcal;
      days++;
    }
  }
  return { kcal: total, days, from };
}

/** Steps per day from Monday to Sunday of `now`'s week (André, 2026-10-26), for the week bars.
 *  `steps` = -1 for a day still to come or with no count. */
export function weekSteps(series: Array<{ date: string; steps?: number }>, now = new Date()):
    { days: Array<{ date: string; label: string; steps: number; today: boolean }>; total: number; max: number } {
  const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${
    String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now);
  const monday = addDays(today, -((now.getDay() + 6) % 7));
  const byDate = new Map<string, number>();
  for (const e of series) if (typeof e.steps === 'number') byDate.set(e.date, e.steps);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let total = 0;
  let max = 0;
  const days = labels.map((label, i) => {
    const date = addDays(monday, i);
    const v = date <= today ? byDate.get(date) : undefined;
    if (v !== undefined) { total += v; max = Math.max(max, v); }
    return { date, label, steps: v ?? -1, today: date === today };
  });
  return { days, total, max };
}

/** Reads the connected watch's daily steps and stores them. Returns how many days were read,
 *  0 for a watch without them. Best-effort: never throws, so a sync never fails because of it. */
export async function syncWatchSteps(): Promise<number> {
  try {
    const info = await getDeviceInfo();
    const model = `${info?.model ?? ''} ${info?.name ?? ''}`.toLowerCase();
    if (!AMBIT3_MODELS.some(c => model.includes(c)) && !model.includes('ambit3')) return 0;
    const decoded = decodeWatchSteps(await readObjectRaw(DEVICE_HISTORY_QUERY));
    if (!decoded) return 0;
    // Each watch's days are kept apart and merged (storeByWatch): its serial names it.
    const watch = String(info?.serial ?? '').trim() || 'watch';
    const stepsByWatch = await mergeWatchSteps(decoded.days, watch);
    await mergeWatchActivity(decoded, watch, stepsByWatch);
    return decoded.days.length;
  } catch (e: any) {
    console.log('[steps] daily steps read failed:', e?.message ?? e);
    return 0;
  }
}
