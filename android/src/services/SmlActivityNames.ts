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
