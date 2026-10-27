import { decodeScale, Settle, estimateBodyComp } from '../ScaleDecode';

// Payloads shaped like the 2026-10-15 capture of the FIT 8S, with a made-up address and weight (the
// same ones tools/test_etekcity_scale.py checks), so the phone and the desktop decode the scale identically.
const RAMP = '01010000eeffc0c0a901f4790000000000020300';       // 31.22 kg, still settling
const SETTLED = '01010000eeffc0c0a90172230100000000020300';     // 74.61 kg, not final
const FINAL_500 = '01010000eeffc0c0a901722301f4010100020300';   // 74.61 kg, 500 ohm
const FINAL_499 = '01010000eeffc0c0a901722301f3010100020300';
const SOCKS = '01010000eeffc0c0a90172230100000100020300';       // final, impedance 0
// settled-packet shape with the weight bytes zeroed: someone just stepped off
const ZERO = SETTLED.slice(0, 20) + '000000' + SETTLED.slice(26);

describe('decodeScale', () => {
  it('reads weight in grams, address reversed, and the final flag', () => {
    const d = decodeScale(RAMP)!;
    expect(d.address).toBe('C0:FF:EE:00:00:01');
    expect(d.weightKg).toBeCloseTo(31.22, 6);
    expect(d.final).toBe(false);
    expect(d.impedanceOhm).toBeNull();
  });
  it('gives the impedance only on the final packet', () => {
    expect(decodeScale(SETTLED)!.impedanceOhm).toBeNull();
    expect(decodeScale(FINAL_500)!.impedanceOhm).toBe(500);
    expect(decodeScale(FINAL_499)!.impedanceOhm).toBe(499);
  });
  it('impedance 0 on a final packet means not measured (socks)', () => {
    const d = decodeScale(SOCKS)!;
    expect(d.final).toBe(true);
    expect(d.impedanceOhm).toBeNull();
  });
  it('rejects anything that is not a 20-byte weight packet', () => {
    expect(decodeScale('00'.repeat(20))).toBeNull();
    expect(decodeScale('0102')).toBeNull();
    expect(decodeScale('zz')).toBeNull();
  });
});

describe('Settle', () => {
  const fin = decodeScale(FINAL_500)!, ramp = decodeScale(SETTLED)!, zero = decodeScale(ZERO)!;
  it('one weigh-in per step-on', () => {
    const s = new Settle(15);
    expect(s.feed(ramp, 0)).toBeNull();
    expect(s.feed(fin, 5.5)).toBe(fin);
    expect(s.feed(fin, 8)).toBeNull();                       // repeat while standing there
  });
  it('a re-measure while standing still is not a new weigh-in', () => {
    const s = new Settle(15);
    expect(s.feed(fin, 0)).toBe(fin);
    expect(s.feed(ramp, 6)).toBeNull();                      // impedance dropped to 0, weight high
    expect(s.feed(fin, 9)).toBeNull();
  });
  it('a long silence, or the weight returning to ~0, starts a new weigh-in', () => {
    const s = new Settle(15);
    expect(s.feed(fin, 0)).toBe(fin);
    expect(s.feed(fin, 40)).toBe(fin);                       // 15 s+ silence
    expect(s.feed(zero, 41)).toBeNull();
    expect(s.feed(ramp, 42)).toBeNull();
    expect(s.feed(fin, 43)).toBe(fin);                       // stepped off and on again
  });
});

describe('estimateBodyComp (Sun et al. 2003)', () => {
  // Worked by hand: H=180, R=500, W=74.6, male -> H^2/R = 64.8, FFM = 60.836, fat 18.45 %
  it('man, hand-worked', () => {
    const r = estimateBodyComp(74.6, 500, 180, 'M')!;
    expect(r.fatFreeKg).toBeCloseTo(60.84, 2);
    expect(r.fatPct).toBe(18.5);
    expect(r.waterKg).toBeCloseTo(43.57, 1);
  });
  it('woman, hand-worked', () => {
    // H=165, R=600, W=65 -> FFM = -9.53 + 0.69*45.375 + 0.17*65 + 0.02*600 = 44.829
    const r = estimateBodyComp(65, 600, 165, 'f')!;
    expect(r.fatFreeKg).toBeCloseTo(44.83, 2);
    expect(r.fatPct).toBe(31.0);
  });
  it('nothing when not measured or an input is missing', () => {
    expect(estimateBodyComp(74.6, 0, 180, 'M')).toBeNull();
    expect(estimateBodyComp(74.6, null, 180, 'M')).toBeNull();
    expect(estimateBodyComp(74.6, 500, 0, 'M')).toBeNull();
    expect(estimateBodyComp(74.6, 500, 180, '?')).toBeNull();
  });
  it('offset shifts body fat only, clamped to 0..100', () => {
    expect(estimateBodyComp(74.6, 500, 180, 'M', -2)!.fatPct).toBe(16.5);
    expect(estimateBodyComp(74.6, 500, 180, 'M', -90)!.fatPct).toBe(0);
    expect(estimateBodyComp(60, 150, 190, 'M')!.fatPct).toBe(0);   // FFM cannot exceed body weight
  });
});
