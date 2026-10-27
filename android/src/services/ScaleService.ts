import { NativeEventEmitter, NativeModules } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAthleteThresholds } from './ApiIntervalsIcu';
import { decodeScale, estimateBodyComp, ScaleReading, Settle } from './ScaleDecode';

// Local Bluetooth scale (Etekcity FIT 8S) on the phone/tablet: the Android twin of the desktop's
// tools/scale_service.py. The native ScaleBle module forwards each broadcast; this file decodes it,
// keeps ONE weigh-in per step-on on the device, and builds the per-day series with an ESTIMATED
// body composition (computed on read, so a changed height/sex/offset applies to the whole history).
// Nothing leaves the device. Foreground only: it listens while the app is open.

const Native = (NativeModules as any).ScaleBle as
  | { start(): Promise<boolean>; stop(): Promise<boolean> }
  | undefined;

const WEIGHINS_KEY = 'scale.weighIns';
const CONFIG_KEY = 'scale.config';          // { address }
const PROFILE_KEY = 'scale.profile';        // { manual?: {heightCm, sex}, cached?: {heightCm, sex} }
const OFFSET_KEY = 'scale.bodyFatOffset';

export interface WeighIn { t: number; weightKg: number; impedanceOhm: number | null; address: string }
export interface BodyProfile { heightCm: number; sex: 'M' | 'F'; source: 'manual' | 'intervals' }
export interface ScalePoint {
  date: string; weightKg: number; source: 'scale'; t: number;
  bmi?: number; impedanceOhm?: number;
  bodyFatPct?: number; bodyWaterPct?: number; fatFreeKg?: number; estimated?: boolean;
}

export function isScaleAvailable(): boolean { return !!Native; }

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }                  // a corrupt store must not break the screen
}

export async function loadWeighIns(): Promise<WeighIn[]> {
  const list = await readJson<any[]>(WEIGHINS_KEY, []);
  return (Array.isArray(list) ? list : [])
    .filter(r => r && typeof r.t === 'number' && typeof r.weightKg === 'number')
    .sort((a, b) => a.t - b.t);
}

async function appendWeighIn(w: WeighIn): Promise<void> {
  const list = await loadWeighIns();
  list.push(w);
  await AsyncStorage.setItem(WEIGHINS_KEY, JSON.stringify(list));
}

export async function getScaleAddress(): Promise<string | null> {
  return (await readJson<{ address?: string }>(CONFIG_KEY, {})).address ?? null;
}
export async function setScaleAddress(address: string): Promise<void> {
  await AsyncStorage.setItem(CONFIG_KEY, JSON.stringify({ address: address.toUpperCase() }));
}
/** Forget the scale (not the weigh-ins already recorded). */
export async function forgetScale(): Promise<void> {
  stopListening();
  await AsyncStorage.removeItem(CONFIG_KEY);
}

// ---- body profile + offset -------------------------------------------------------------------

export async function getBodyProfile(): Promise<BodyProfile | null> {
  const p = await readJson<any>(PROFILE_KEY, {});
  if (p.manual?.heightCm > 0 && (p.manual.sex === 'M' || p.manual.sex === 'F'))
    return { heightCm: p.manual.heightCm, sex: p.manual.sex, source: 'manual' };
  if (p.cached?.heightCm > 0 && (p.cached.sex === 'M' || p.cached.sex === 'F'))
    return { heightCm: p.cached.heightCm, sex: p.cached.sex, source: 'intervals' };
  return null;
}
export async function setBodyProfile(heightCm: number | null, sex: 'M' | 'F' | null): Promise<void> {
  const p = await readJson<any>(PROFILE_KEY, {});
  const ok = heightCm != null && heightCm >= 100 && heightCm <= 230 && (sex === 'M' || sex === 'F');
  p.manual = ok ? { heightCm, sex } : undefined;
  await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}
/** Refresh the cached height/sex from the intervals.icu profile (best effort, offline is fine). */
export async function refreshProfileFromIntervals(): Promise<void> {
  try {
    const a = await getAthleteThresholds();
    if (a?.height && (a.gender === 1 || a.gender === 0)) {
      const p = await readJson<any>(PROFILE_KEY, {});
      p.cached = { heightCm: a.height, sex: a.gender === 1 ? 'M' : 'F' };
      await AsyncStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    }
  } catch { /* keep the cached value */ }
}
export async function getBodyFatOffset(): Promise<number> {
  const v = parseFloat((await AsyncStorage.getItem(OFFSET_KEY)) ?? '0');
  return Number.isFinite(v) ? v : 0;
}
export async function setBodyFatOffset(v: number): Promise<void> {
  await AsyncStorage.setItem(OFFSET_KEY, String(Math.max(-20, Math.min(20, v))));
}

// ---- the per-day series -----------------------------------------------------------------------

function localDay(tSec: number): string {
  const d = new Date(tSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** One point per day, oldest first. If someone weighed in more than once that day, the latest
 *  weigh-in WITH impedance wins, else the latest. Body composition (marked estimated) appears
 *  only when impedance, height and sex are all known. */
export async function loadScaleSeries(): Promise<ScalePoint[]> {
  const [all, profile, offset] = await Promise.all([loadWeighIns(), getBodyProfile(), getBodyFatOffset()]);
  const byDay = new Map<string, WeighIn>();
  for (const r of all) {
    const d = localDay(r.t);
    const cur = byDay.get(d);
    if (!cur || r.impedanceOhm || !cur.impedanceOhm) byDay.set(d, r);
  }
  return Array.from(byDay.keys()).sort().map(date => {
    const r = byDay.get(date)!;
    const p: ScalePoint = { date, weightKg: Math.round(r.weightKg * 100) / 100, source: 'scale', t: r.t };
    if (profile) p.bmi = Math.round((r.weightKg / (profile.heightCm / 100) ** 2) * 10) / 10;
    if (r.impedanceOhm) {
      p.impedanceOhm = r.impedanceOhm;
      const est = estimateBodyComp(r.weightKg, r.impedanceOhm, profile?.heightCm, profile?.sex, offset);
      if (est) Object.assign(p, { bodyFatPct: est.fatPct, bodyWaterPct: est.waterPct, fatFreeKg: est.fatFreeKg, estimated: true });
    }
    return p;
  });
}

// ---- listening ----------------------------------------------------------------------------------

type Listener = () => void;
let emitter: NativeEventEmitter | null = null;
let subs: { remove(): void }[] = [];
let listening = false;
let lastError: string | null = null;
let lastSeen: number | null = null;       // seconds, last packet from OUR scale
let settle = new Settle();
const changeListeners = new Set<Listener>();
const findCollectors = new Set<(address: string, r: ScaleReading, rssi: number) => void>();

function notify() { changeListeners.forEach(l => { try { l(); } catch { /* a bad listener must not stop the others */ } }); }
export function onScaleChange(l: Listener): () => void { changeListeners.add(l); return () => { changeListeners.delete(l); }; }
export function scaleStatus() { return { available: !!Native, listening, error: lastError, lastSeen }; }

async function handleAdvert(ev: { address: string; rssi: number; hex: string }) {
  const d = decodeScale(ev.hex);
  if (!d) return;
  findCollectors.forEach(c => c(d.address, d, ev.rssi));
  const want = await getScaleAddress();
  if (want && d.address.toUpperCase() !== want) return;
  if (!want) return;                              // only a scale that was set up is recorded
  const now = Date.now() / 1000;
  lastSeen = now;
  const res = settle.feed(d, now);
  if (res) {
    await appendWeighIn({ t: Math.floor(now), weightKg: res.weightKg, impedanceOhm: res.impedanceOhm, address: res.address });
    notify();
  }
}

function ensureEmitter() {
  if (emitter || !Native) return;
  emitter = new NativeEventEmitter(Native as any);
  subs = [
    emitter.addListener('ScaleBleAdvert', handleAdvert),
    emitter.addListener('ScaleBleError', (e: any) => { listening = false; lastError = `Bluetooth scan failed (code ${e?.code})`; notify(); }),
  ];
}

export async function startListening(): Promise<void> {
  if (!Native) { lastError = 'This build has no Bluetooth scale support.'; notify(); return; }
  ensureEmitter();
  settle = new Settle();
  try {
    await Native.start();
    listening = true; lastError = null;
  } catch (e: any) {
    listening = false; lastError = String(e?.message ?? e);
  }
  notify();
}

export function stopListening(): void {
  if (!Native) return;
  Native.stop().catch(() => {});
  listening = false;
  notify();
}

export interface FoundScale { address: string; weightKg: number; rssi: number }

/** Listen for scales for `seconds` (set-up wizard): every FIT 8S heard, strongest first. */
export async function findScales(seconds = 20): Promise<FoundScale[]> {
  if (!Native) throw new Error('This build has no Bluetooth scale support.');
  ensureEmitter();
  const found = new Map<string, FoundScale>();
  const collect = (address: string, r: ScaleReading, rssi: number) =>
    found.set(address, { address, weightKg: r.weightKg, rssi });
  findCollectors.add(collect);
  const wasListening = listening;
  try {
    await Native.start();
    await new Promise<void>(res => setTimeout(res, seconds * 1000));
  } finally {
    findCollectors.delete(collect);
    if (!wasListening) Native.stop().catch(() => {});
  }
  return Array.from(found.values()).sort((a, b) => b.rssi - a.rssi);
}

/** Start listening again after the app restarts, if a scale was set up. */
export async function resumeIfConfigured(): Promise<void> {
  if (!listening && (await getScaleAddress())) await startListening();
}
