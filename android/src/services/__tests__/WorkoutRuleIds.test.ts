// Byte-equal with the desktop: the fixture is generated from guided_workout.py's with_rule_id /
// free_rule_id / restamp_rule_ids (A: per-sport rule 0, B: any-mode 11000001, C: per-sport
// 11000001 shared, D: a generic app, E: any-mode rule 2 - C must skip 2 as E holds it).
import fx from './rule_ids.fixture.json';
import { decodeApps } from '../AppsCodec';
import { withRuleId, freeRuleId, restampRuleIds, ruleIdOf, programKey } from '../WorkoutRuleIds';

const u8 = (a: number[]) => Uint8Array.from(a);

it('withRuleId matches the desktop, with and without the magic', () => {
  for (const c of fx.withRuleId) {
    const out = withRuleId(u8(c.in), c.id);
    expect(Array.from(out)).toEqual(c.out);
    expect(ruleIdOf(out)).toBe(c.id);
  }
  expect(() => withRuleId(u8(fx.withRuleId[0].in), 10)).toThrow();
  expect(() => withRuleId(u8([0, 1, 2]), 1)).toThrow();
});

it('freeRuleId matches the desktop', () => {
  for (const c of fx.freeRuleId) expect(freeRuleId(c.used)).toBe(c.free);
});

it('restampRuleIds rebuilds the same blocks as the desktop', () => {
  const { entries, repaired } = restampRuleIds(decodeApps(u8(fx.restamp.region)));
  expect(entries.map((e) => Array.from(e.rawBlock))).toEqual(fx.restamp.blocks);
  expect(repaired).toEqual(fx.restamp.repaired);
});

it('programKey ignores the rule id', () => {
  const [a] = fx.withRuleId;
  expect(Array.from(programKey(withRuleId(u8(a.in), 3)))).toEqual(Array.from(programKey(withRuleId(u8(a.in), 7))));
  expect(Array.from(programKey(u8(a.in)))).toEqual(Array.from(programKey(withRuleId(u8(a.in), 4))));
});
