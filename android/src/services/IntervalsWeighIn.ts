import AsyncStorage from '@react-native-async-storage/async-storage';
import { getIntervalsIcuCredentials } from './ApiIntervalsIcu';

// Sommet's own weigh-ins (Bluetooth scale, typed by hand) -> intervals.icu wellness, when it is
// connected (🟣76, 2026-10-27; desktop twin: WeightService::sendWeighInToIntervals). A device
// never writes to intervals.icu; only weigh-ins taken in Sommet go there. Weight is on by default;
// body fat is a second opt-in because the scale's number is an estimate and intervals.icu doesn't
// mark it as one. One PUT per day: a merge, so only weight / bodyFat change on that day.

const API_BASE = 'https://intervals.icu/api/v1';
const SEND_KEY = 'weight.sendToIntervals';
const BODYFAT_KEY = 'weight.sendBodyFatToIntervals';

export async function getSendWeighIns(): Promise<boolean> {
  return (await AsyncStorage.getItem(SEND_KEY)) !== '0';
}
export async function setSendWeighIns(on: boolean): Promise<void> {
  await AsyncStorage.setItem(SEND_KEY, on ? '1' : '0');
}
export async function getSendBodyFat(): Promise<boolean> {
  return (await AsyncStorage.getItem(BODYFAT_KEY)) === '1';
}
export async function setSendBodyFat(on: boolean): Promise<void> {
  await AsyncStorage.setItem(BODYFAT_KEY, on ? '1' : '0');
}

/** Send one day's weigh-in. Quiet no-op when switched off or intervals.icu isn't connected;
 *  returns false only when a send was tried and failed. */
export async function sendWeighInToIntervals(date: string, weightKg: number, bodyFatPct?: number | null): Promise<boolean> {
  if (!date || !(weightKg > 0) || !(await getSendWeighIns())) return true;
  const creds = await getIntervalsIcuCredentials();
  if (!creds) return true;
  const body: Record<string, number> = { weight: Math.round(weightKg * 100) / 100 };
  if (bodyFatPct != null && bodyFatPct > 0 && (await getSendBodyFat())) body.bodyFat = Math.round(bodyFatPct * 10) / 10;
  try {
    const resp = await fetch(`${API_BASE}/athlete/${encodeURIComponent(creds.athleteId)}/wellness/${date}`, {
      method: 'PUT',
      headers: {
        Authorization: 'Basic ' + btoa(`API_KEY:${creds.apiKey}`),
        'Content-Type': 'application/json',
        'User-Agent': 'Sommet/1.0',
      },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}
