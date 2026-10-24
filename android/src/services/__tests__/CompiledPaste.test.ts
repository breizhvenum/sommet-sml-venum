// The paste box (CompiledPasteBox) takes only a real compiled result - the JSON the compiler
// site shows in its lower box - never stray text, which must not end up on the watch.
jest.mock('../../native/AmbitUsbModule', () => ({}));
jest.mock('../AppInstall', () => ({}));
import { parseCompiledText } from '../IntervalsService';

// Same keys as the site's reply (checked against a real compile, 2026-10-24).
const reply = { ruleId: 11000001, name: 'Ambit App', categoryId: 0, activityId: 1, userCount: 1,
  binary: [1, 2, 255, 0], compatibleVariants: ['Emu', 'Finch', 'Kailash'] };

it('takes the site reply as pasted', () => {
  const c = parseCompiledText(JSON.stringify(reply, null, 2), 'Test')!;
  expect(Array.from(c.binary)).toEqual([1, 2, 255, 0]);
  expect(c.activityId).toBe(1);
  expect(c.name).toBe('Ambit App');
});

it('takes a one-element array and surrounding whitespace', () => {
  expect(parseCompiledText(`\n  ${JSON.stringify([reply])}  \n`, 'Test')!.binary.length).toBe(4);
});

it('uses the fallback name when the reply has none', () => {
  const { name, ...noName } = reply;
  expect(parseCompiledText(JSON.stringify(noName), 'Test')!.name).toBe('Test');
});

it.each([
  ['plain text', 'hello'],
  ['the workout source pasted back', JSON.stringify({ name: 'Test', steps: [] })],
  ['an empty binary', JSON.stringify({ ...reply, binary: [] })],
  ['a value that is not a byte', JSON.stringify({ ...reply, binary: [1, 256] })],
  ['a non-number', JSON.stringify({ ...reply, binary: [1, '2'] })],
  ['half a paste', JSON.stringify(reply).slice(0, 40)],
  ['nothing', ''],
])('refuses %s', (_label, text) => {
  expect(parseCompiledText(text, 'Test')).toBeNull();
});
