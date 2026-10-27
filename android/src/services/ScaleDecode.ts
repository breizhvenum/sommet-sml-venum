// Etekcity FIT 8S Bluetooth scale: decoder, weigh-in settling and the estimated body composition.
// The TypeScript twin of tools/etekcity_scale.py, tools/body_composition.py (desktop) - the same
// real payloads are tested on both sides so the phone and the desktop read the scale the same way.
//
// The scale is broadcast-only: it advertises its reading while someone stands on it. No pairing,
// no app, no account. Layout (20 bytes, manufacturer id 0x06D0), confirmed by our own capture and
// by openScale's EtekcityFit8SHandler (github.com/oliexdev/openScale, GPL-3.0), which takes it from
// github.com/ronnnnnnnnnnnnn/etekcity_esf551_ble:
//   0 = 0x01 | 1..6 own address, reversed | 7..9 model | 10..12 weight in GRAMS (3-byte LE)
//   13..14 impedance in OHM (u16 LE, 0 = not measured) | 15 = 1 final reading | 16 display unit
//
// The body-composition equations are Sun SS, Chumlea WC, Heymsfield SB, et al., Am J Clin Nutr
// 2003;77:331-340 (also used by openScale; coefficients checked against its source). An
// independent implementation, not a copy of openScale's code.

export const SCALE_COMPANY_ID = 0x06d0;

export interface ScaleReading {
  address: string;           // "AA:BB:..."
  weightKg: number;
  impedanceOhm: number | null; // only on the final reading, and only when feet touched the pads
  final: boolean;
}

function fromHex(hex: string): number[] | null {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) return null;
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** Decode one manufacturer-data payload (hex string, company id already removed). Null if it is
 *  not a FIT 8S weight packet. */
export function decodeScale(hex: string): ScaleReading | null {
  const b = fromHex(hex);
  if (!b || b.length !== 20 || b[0] !== 0x01) return null;
  const address = b.slice(1, 7).reverse().map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
  const weightKg = (b[10] | (b[11] << 8) | (b[12] << 16)) / 1000;
  const final = b[15] === 1;
  const imp = b[13] | (b[14] << 8);
  return { address, weightKg, impedanceOhm: final && imp > 0 ? imp : null, final };
}

/** Turns the packet stream into one result per weigh-in. A real step-on starts from about 0 kg or
 *  follows a long silence; the scale also re-measures (impedance 0, then back) while you stand
 *  still, and repeats its final packet - neither is a new weigh-in. Measured 2026-10-16. */
export class Settle {
  private lastT: number | null = null;
  private armed = true;
  // A weigh-in also needs `confirm` final packets in a row with the same weight: the scale sends
  // about 50 over 5 s, and a single stray final packet once gave a 13.23 kg weigh-in between two
  // real ~92 kg ones on this phone app (2026-10-27).
  private run = 0;
  private runKg = 0;
  constructor(private silenceSec = 15, private nearZeroKg = 5, private confirm = 3) {}

  feed(d: ScaleReading | null, nowSec: number): ScaleReading | null {
    if (!d) return null;
    if (this.lastT !== null && nowSec - this.lastT >= this.silenceSec) { this.armed = true; this.run = 0; }
    this.lastT = nowSec;
    if (!d.final) {
      this.run = 0;
      if (d.weightKg < this.nearZeroKg) this.armed = true;
      return null;
    }
    if (this.run > 0 && Math.abs(d.weightKg - this.runKg) < 0.005) this.run += 1;
    else { this.run = 1; this.runKg = d.weightKg; }
    if (this.armed && this.run >= this.confirm) {
      this.armed = false;
      return d;
    }
    return null;
  }
}

export interface BodyComp {
  fatPct: number;
  fatFreeKg: number;
  waterKg: number;
  waterPct: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** ESTIMATED body composition from impedance (Sun et al. 2003). Null when impedance is 0 (socks,
 *  no contact) or an input is missing - never a made-up number. `offsetPct` shifts body fat to a
 *  reference the person trusts. */
export function estimateBodyComp(
  weightKg: number, impedanceOhm: number | null | undefined, heightCm: number | null | undefined,
  sex: string | null | undefined, offsetPct = 0,
): BodyComp | null {
  if (!(weightKg > 0) || !(impedanceOhm! > 0) || !(heightCm! > 0)) return null;
  const sx = String(sex ?? '').toUpperCase().slice(0, 1);
  if (sx !== 'M' && sx !== 'F') return null;
  const R = impedanceOhm as number, H = heightCm as number;
  const h2r = (H * H) / R;
  let ffm: number, water: number;
  if (sx === 'M') {
    ffm = -10.68 + 0.65 * h2r + 0.26 * weightKg + 0.02 * R;
    water = 0.99513 * (1.2 + 0.45 * h2r + 0.18 * weightKg);
  } else {
    ffm = -9.53 + 0.69 * h2r + 0.17 * weightKg + 0.02 * R;
    water = 0.99513 * (3.75 + 0.45 * h2r + 0.11 * weightKg);
  }
  ffm = Math.min(Math.max(ffm, 0), weightKg);
  const fat = Math.min(Math.max((1 - ffm / weightKg) * 100 + offsetPct, 0), 100);
  return { fatPct: r1(fat), fatFreeKg: r2(ffm), waterKg: r2(water), waterPct: r1((water / weightKg) * 100) };
}
