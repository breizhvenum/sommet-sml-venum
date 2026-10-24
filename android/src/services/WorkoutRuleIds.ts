import { AppEntry, MAGIC, NAME_LEN, entryChecksum } from './AppsCodec';
import { GUIDANCE_ENTRY_TYPE } from './GuidedWorkoutCore';

// How native workouts sit on the watch so a pick runs the workout picked - the port of
// guided_workout.py's ANY_MODE_ACTIVITY / with_rule_id / free_rule_id / restamp_rule_ids
// (desktop since 2026-10-05; Android caught up 2026-10-24, André: "14 yes"). Kept byte-equal
// with the Python by __tests__/WorkoutRuleIds.test.ts (fixture generated from it).
//
// The WORKOUT menu runs the picked ROW's position in the firmware's 5-slot table but LISTS only
// the rows of the current sport (the filter treats a sport byte < 2 as "every mode"). With two
// sports installed the orders differ and a pick runs another workout (André's Peak, 2026-10-05:
// a Running pick ran the swim test stored first). So every native workout gets the any-mode
// byte: each mode lists all of them in storage order, row == slot, and you pick by name.
export const ANY_MODE_ACTIVITY = 1;

// The compiler gives every binary the same rule id (0, or 11000001 since 2026-10-09) and the
// symbol "rule0"; a real install never shared one and the exercise log records it, so each
// installed workout gets its own 1..9. The symbol is patched in place: one digit only.
export const RULE_ID_OFFSET = 12; // u32 in the magic-less binary: ver, outFmtDiv, one, ruleId

function hasMagic(b: Uint8Array): boolean {
  if (b.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
  return true;
}

/** apps.decode's ruleId: u32 @12 of the magic-less binary (0 when too short). */
export function ruleIdOf(binary: Uint8Array): number {
  const b = hasMagic(binary) ? binary.subarray(MAGIC.length) : binary;
  if (b.length < 16) return 0;
  return (b[12] | (b[13] << 8) | (b[14] << 16) | (b[15] << 24)) >>> 0;
}

/** The binary WITHOUT the magic, its ruleId u32 and "rule<N>" symbol set to `ruleId` (1..9).
 * Throws when the id is out of range or there isn't exactly one one-digit "rule<d>\0". */
export function withRuleId(binary: Uint8Array, ruleId: number): Uint8Array {
  if (!(Number.isInteger(ruleId) && ruleId >= 1 && ruleId <= 9)) {
    throw new Error(`rule id ${ruleId} must be 1..9 (the symbol is patched in place)`);
  }
  const b = Uint8Array.from(hasMagic(binary) ? binary.subarray(MAGIC.length) : binary);
  const sites: number[] = [];
  for (let i = 0; i + 5 < b.length; i++) {
    if (b[i] === 0x72 && b[i + 1] === 0x75 && b[i + 2] === 0x6c && b[i + 3] === 0x65
        && b[i + 4] >= 0x30 && b[i + 4] <= 0x39 && b[i + 5] === 0) sites.push(i);
  }
  if (sites.length !== 1) throw new Error('binary has no single one-digit rule<N> symbol - not patched');
  b[RULE_ID_OFFSET] = ruleId; b[RULE_ID_OFFSET + 1] = 0; b[RULE_ID_OFFSET + 2] = 0; b[RULE_ID_OFFSET + 3] = 0;
  b[sites[0] + 4] = 0x30 + ruleId;
  return b;
}

/** The lowest id in 1..9 no entry uses, or null when all nine are taken. */
export function freeRuleId(ruleIds: number[]): number | null {
  const used = new Set(ruleIds);
  for (let i = 1; i <= 9; i++) if (!used.has(i)) return i;
  return null;
}

/** Every native workout gets the any-mode byte and, when its rule id is 0 or shared with an
 * earlier entry, a free one (block rebuilt with a fresh marker). Repairs workouts installed
 * before this port; a generic Suunto App is never touched. `repaired` lists [name, rule id]. */
export function restampRuleIds(entries: AppEntry[]): { entries: AppEntry[]; repaired: [string, number][] } {
  const out: AppEntry[] = [];
  const seen = new Set<number>();
  const repaired: [string, number][] = [];
  for (const e0 of entries) {
    let e: AppEntry = { ...e0 };
    let rid = ruleIdOf(e.binary);
    const native = e.rawBlock[0] === GUIDANCE_ENTRY_TYPE;
    if (native && e.activityId !== ANY_MODE_ACTIVITY) {
      const blk = Uint8Array.from(e.rawBlock);
      blk[1] = ANY_MODE_ACTIVITY;
      e = { ...e, rawBlock: blk, activityId: ANY_MODE_ACTIVITY };
      repaired.push([e.name, rid]);
    }
    if (native && (!rid || seen.has(rid))) {
      const free = freeRuleId([...out, ...entries.slice(out.length)].map((x) => ruleIdOf(x.binary)));
      if (free != null) {
        let binary: Uint8Array | null;
        try { binary = withRuleId(e.binary, free); } catch { binary = null; }
        if (binary) {
          const blk = e.rawBlock;
          const block = new Uint8Array(3 + NAME_LEN + MAGIC.length + binary.length);
          block.set([GUIDANCE_ENTRY_TYPE, ANY_MODE_ACTIVITY, entryChecksum(binary)], 0);
          block.set(blk.subarray(3, 3 + NAME_LEN), 3);
          block.set(MAGIC, 3 + NAME_LEN);
          block.set(binary, 3 + NAME_LEN + MAGIC.length);
          e = { ...e, rawBlock: block, binary, marker: block[2] };
          rid = free;
          repaired.push([e.name, free]);
        }
      }
    }
    if (rid) seen.add(rid);
    out.push(e);
  }
  return { entries: out, repaired };
}

/** The program a workout runs, whatever rule id it was installed with - what an edit check
 * compares (ids are handed out per install, so they differ between equal workouts). */
export function programKey(binary: Uint8Array): Uint8Array {
  try { return withRuleId(binary, 1); } catch { return hasMagic(binary) ? binary.subarray(MAGIC.length) : binary; }
}
