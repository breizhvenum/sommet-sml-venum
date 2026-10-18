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

export const DEVICE_HISTORY_QUERY = 0x97;
const STEPS_ID = 0x12e;
const TIMESTAMP_ID = 0x130;
const DAYS = 30;
const NO_COUNT = 0xffffffff;
const STORE_KEY = 'health.watchSteps';
// Ambit3 Peak, Sport, Run, Vertical (the model name the watch itself reports). The Kailash,
// Traverse and Ambit1/2 number their fields differently or keep no daily steps.
const AMBIT3_MODELS = ['emu', 'finch', 'ibisbill', 'kaka'];

export interface StepsDay { date: string; steps: number; today: boolean }
export interface WatchSteps { timestamp: string; days: StepsDay[] }

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
  for (const [id, s, e] of sbemEntries(b, at)) {
    if (id === STEPS_ID && steps === null) steps = [s, e];
    if (id === TIMESTAMP_ID && !stamp) {
      let end = s;
      while (end < e && b[end] !== 0) end++;
      stamp = String.fromCharCode(...Array.from(b.subarray(s, end)));
    }
  }
  if (!steps || steps[1] - steps[0] !== DAYS * 4) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}/.exec(stamp);
  if (!m) return null;
  const today = m[1];
  const days: StepsDay[] = [];
  for (let i = 0; i < DAYS; i++) {
    const n = u32(b, steps[0] + i * 4);
    if (n === NO_COUNT) continue;
    days.push({ date: addDays(today, i - (DAYS - 1)), steps: n, today: i === DAYS - 1 });
  }
  return { timestamp: stamp, days };
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

/** Merges a read into the store: a newer read of a day replaces the older one (today's count
 *  grows; past days don't change on the watch). */
export async function mergeWatchSteps(days: StepsDay[]): Promise<void> {
  const byDate = new Map<string, number>();
  for (const e of await loadWatchSteps()) byDate.set(e.date, e.steps);
  for (const d of days) byDate.set(d.date, d.steps);
  const list = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, steps]) => ({ date, steps }));
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list));
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
    await mergeWatchSteps(decoded.days);
    return decoded.days.length;
  } catch (e: any) {
    console.log('[steps] daily steps read failed:', e?.message ?? e);
    return 0;
  }
}
