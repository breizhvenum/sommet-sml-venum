// Which sport-mode displays are the user's screens: the Sport Modes screen must count them as
// the desktop does (tools/custom_modes.py user_display_count: the displays whose Type is 10).
// Android used to match the end of the display list against two known built-in "tails"; a
// mode whose list ended any other way had its built-in views counted as screens ("8/8" for a
// mode with 5). The images are the SuuntoLink capture SportModeCodec.test.ts replays.

import { decode as readModes } from '../CustomModesReader';
import { decode as decodeRegion, encodeBody } from '../SportModeCodec';
import capture from './sportmode_capture.json';

declare const Buffer: { from(data: string, encoding: string): Uint8Array };

const img = (i: number) => new Uint8Array(Buffer.from((capture as Record<string, string>)[String(i)], 'base64'));

// tools/custom_modes.py user_display_count() for every mode of every image, in order
// (generated 2026-10-24 from this same fixture).
const DESKTOP_COUNTS: Record<string, number[]> = {
  0: [3, 1, 5, 5, 4, 3, 4, 3, 3], 1: [3, 1, 5, 5, 4, 3, 4, 3, 3, 0], 2: [3, 1, 5, 5, 4, 3, 4, 3, 3, 1],
  3: [3, 1, 5, 5, 4, 3, 4, 3, 3, 1], 4: [3, 5, 5, 4, 3, 4, 3, 3, 1], 5: [3, 5, 5, 4, 3, 4, 3, 3, 1],
  6: [3, 5, 5, 4, 3, 4, 3, 3], 7: [3, 5, 5, 4, 3, 4, 3, 3], 8: [3, 5, 5, 4, 3, 4, 3, 3],
  9: [3, 5, 5, 4, 3, 4, 3, 3], 10: [3, 5, 5, 4, 3, 4, 3, 3], 11: [3, 5, 5, 4, 3, 4, 3, 3],
  12: [3, 5, 5, 4, 3, 4, 3, 3, 0], 13: [3, 5, 5, 4, 3, 4, 3, 3, 1], 14: [3, 5, 5, 4, 3, 4, 3, 3, 1],
  15: [3, 5, 5, 4, 3, 4, 3, 3, 1], 16: [3, 5, 5, 4, 3, 4, 3, 3, 1],
};

const userCount = (bytes: Uint8Array) =>
  readModes(bytes).exerciseModes.map(m => m.displays.filter(d => !d.isBuiltIn).length);

describe('CustomModesReader user screens', () => {
  test('every capture image counts the same screens as the desktop', () => {
    for (let i = 0; i <= 16; i++) expect(userCount(img(i))).toEqual(DESKTOP_COUNTS[i]);
  });

  test('screens are numbered from 1 and built-in views have no number', () => {
    for (const mode of readModes(img(0)).exerciseModes) {
      mode.displays.forEach((d, i) => {
        expect(d.isBuiltIn).toBe(d.type !== 10);
        expect(d.screenNumber).toBe(d.isBuiltIn ? null : i + 1);
      });
    }
  });

  test('a mode whose list ends in an unknown way still counts only its own screens', () => {
    // Drop the last built-in view of every mode: no list ends in a known tail any more, which
    // is the case the old rule got wrong.
    const region = decodeRegion(img(0));
    for (const mode of region.exercise_modes) mode.Displays.pop();
    expect(userCount(encodeBody(region))).toEqual(DESKTOP_COUNTS[0]);
  });
});
