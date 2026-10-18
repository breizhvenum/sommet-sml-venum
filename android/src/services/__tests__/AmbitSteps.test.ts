const store: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k: string) => store[k] ?? null),
  setItem: jest.fn(async (k: string, v: string) => { store[k] = v; }),
}));
jest.mock('../../native/AmbitUsbModule', () => ({ getDeviceInfo: jest.fn(), readObjectRaw: jest.fn() }));
import { bytesToBase64 } from '../Base64';
import { decodeWatchSteps, loadWatchSteps, mergeWatchSteps } from '../AmbitSteps';

// Same shape as tools/test_ambit_steps.py: a DeviceHistory reply as a real Ambit3 Peak sends it
// (fw 2.4.17, 2026-10-18) - short-id ActivityTracking entries, then the 30-day steps record and
// the timestamp as long-id entries [ff][u16 id][len]. The numbers are made up.
function entry(id: number, data: number[]): number[] {
  const head = id < 0xff ? [id] : [0xff, id & 0xff, id >> 8];
  return [...head, data.length, ...data];
}
function u32s(values: number[]): number[] {
  return values.flatMap(v => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}
function reply(steps: number[], stamp = '2026-10-18T13:06:02+03:00', cursor = 0): string {
  const magic = Array.from('SBEM0102').map(c => c.charCodeAt(0));
  const bytes = [
    ...u32s([cursor]), 1, 0, ...magic,
    ...entry(0x92, [77, 0, 76, 0]),
    ...entry(0x12e, u32s(steps)),
    ...entry(0x130, [...Array.from(stamp).map(c => c.charCodeAt(0)), 0]),
  ];
  return bytesToBase64(new Uint8Array(bytes));
}

const counts = [...Array(26).fill(0xffffffff), 17194, 6759, 5798, 5];

describe('decodeWatchSteps', () => {
  it('dates the 30 slots back from the timestamp, oldest first, skipping no-count days', () => {
    const r = decodeWatchSteps(reply(counts))!;
    expect(r.days).toEqual([
      { date: '2026-10-15', steps: 17194, today: false },
      { date: '2026-10-16', steps: 6759, today: false },
      { date: '2026-10-17', steps: 5798, today: false },
      { date: '2026-10-18', steps: 5, today: true },
    ]);
  });
  it('crosses a month boundary', () => {
    const r = decodeWatchSteps(reply([...Array(29).fill(0xffffffff), 100].map((v, i) => (i === 0 ? 1 : v)), '2026-03-01T08:00:00+03:00'))!;
    expect(r.days[0]).toEqual({ date: '2026-01-31', steps: 1, today: false });
    expect(r.days[1]).toEqual({ date: '2026-03-01', steps: 100, today: true });
  });
  it('refuses another layout or an unfinished page instead of guessing', () => {
    expect(decodeWatchSteps(reply(counts.slice(0, 16)))).toBeNull();
    expect(decodeWatchSteps(reply(counts, 'not a date'))).toBeNull();
    expect(decodeWatchSteps(reply(counts, undefined, 0x18))).toBeNull();
  });
});

describe('mergeWatchSteps', () => {
  it('keeps old days and lets a newer read replace a day', async () => {
    await mergeWatchSteps([{ date: '2026-09-01', steps: 9000, today: false }]);
    await mergeWatchSteps([{ date: '2026-10-18', steps: 5, today: true }]);
    await mergeWatchSteps([{ date: '2026-10-18', steps: 4200, today: true }]);
    expect(await loadWatchSteps()).toEqual([
      { date: '2026-09-01', steps: 9000 }, { date: '2026-10-18', steps: 4200 }]);
  });
});
