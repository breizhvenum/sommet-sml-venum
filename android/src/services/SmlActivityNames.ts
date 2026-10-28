import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDeviceInfo, readCustomModesRaw } from '../native/AmbitUsbModule';
import { base64ToBytes } from './Base64';
import { decode } from './CustomModesReader';
import { isAmbit12 } from './AmbitSettingsService';

/**
 * {CustomModeID: name} of the sport modes stored on the connected Ambit3-family watch. A move's
 * Activity event carries the CustomModeID it was recorded with, and Moveslink2 writes that mode's
 * name as the SML <Activity> ("Windsurf IDF") - the watch's own log header leaves the name empty.
 * Best-effort: any failure (Ambit1/2, link error) returns {} and the SML simply keeps no name.
 * Call with the watch still connected (after getLogs()); it is a read-only 12 KB flash read.
 */
export async function readCustomModeNames(): Promise<Record<string, string>> {
  try {
    try { if (isAmbit12((await getDeviceInfo()).name)) return {}; } catch { /* assume Ambit3 */ }
    const decoded = decode(base64ToBytes(await readCustomModesRaw()));
    const out: Record<string, string> = {};
    for (const m of decoded.exerciseModes) {
      const id = m.settings.customModeId;
      if (id !== undefined && m.settings.name) out[String(id)] = m.settings.name;
    }
    return out;
  } catch (e: any) {
    console.log('[sml] could not read the sport-mode names:', e?.message ?? e);
    return {};
  }
}

const SML_STATUS_KEY = 'sommet_sml_last_status';

/** Remembers what the SML step of the last sync did (shown by the export menu when no SML exists,
 *  so a missing file can be explained instead of silently absent). Never throws. */
export async function saveSmlStatus(text: string): Promise<void> {
  try { await AsyncStorage.setItem(SML_STATUS_KEY, `${new Date().toISOString()}  ${text}`); } catch { /* ignore */ }
}
export async function loadSmlStatus(): Promise<string> {
  try { return (await AsyncStorage.getItem(SML_STATUS_KEY)) ?? ''; } catch { return ''; }
}

/** Rejects after `ms` so a stuck watch read can never block the sync. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
