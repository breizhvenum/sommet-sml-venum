// An activity id becomes a file name: no ':' may reach react-native-fs, which reads it as a URL.
const mockFiles = new Map<string, string>();
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/data/user/0/app/mockFiles',
  exists: jest.fn(async (p: string) => mockFiles.has(p) || p.endsWith('/activities')),
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(async (p: string, data: string) => { mockFiles.set(p, data); }),
}));

import RNFS from 'react-native-fs';
import { activityExists, activityFileStem, writeFitFile, writeGpxFile } from '../GpxService';

beforeEach(() => { mockFiles.clear(); jest.clearAllMocks(); });

test('intervals.icu ids are stored without the colon', async () => {
  const path = await writeGpxFile('icu:i195012534', '<gpx/>', true);
  expect(path).toBe('/data/user/0/app/mockFiles/activities/icu_i195012534.gpx');
  expect(await activityExists('icu:i195012534')).toBe(true);
  const fit = await writeFitFile('icu:i195012534', 'AAAA', true);
  expect(fit).toBe('/data/user/0/app/mockFiles/activities/icu_i195012534.fit');
  for (const call of (RNFS.writeFile as jest.Mock).mock.calls) {
    expect(call[0].split('/').pop()).not.toContain(':');
  }
});

test('the other importers keep their file names', () => {
  for (const id of ['20240615T093000', 'garmin_edge530_20240615093000', 'coros_461234',
                    'c406_1718444400', 'bryton_240615093000', 'sommet_abc_123', 'log_1718_0']) {
    expect(activityFileStem(id)).toBe(id);
  }
});

test('an existing file is not overwritten unless asked', async () => {
  await writeGpxFile('icu:i1', 'first', true);
  expect(await writeGpxFile('icu:i1', 'second')).toBeNull();
  expect(mockFiles.get('/data/user/0/app/mockFiles/activities/icu_i1.gpx')).toBe('first');
});
