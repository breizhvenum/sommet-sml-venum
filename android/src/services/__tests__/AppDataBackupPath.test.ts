jest.mock('react-native-fs', () => ({ DocumentDirectoryPath: '/new/files' }));
jest.mock('@react-native-async-storage/async-storage', () => ({}));
jest.mock('../../database/db', () => ({ getDb: jest.fn() }));
jest.mock('../../native/AmbitUsbModule', () => ({ saveFileAs: jest.fn(), pickGpxFile: jest.fn() }));

import { rewriteActivityPath } from '../AppDataBackupService';

test('a restored track points at the new install, under the same file name', () => {
  expect(rewriteActivityPath({ id: '20240615T093000', gpx_path: '/old/files/activities/20240615T093000.gpx' },
    '/new/files/activities').gpx_path).toBe('/new/files/activities/20240615T093000.gpx');
  expect(rewriteActivityPath({ id: 'icu:i195012534', gpx_path: '/old/files/activities/icu_i195012534.gpx' },
    '/new/files/activities').gpx_path).toBe('/new/files/activities/icu_i195012534.gpx');
});

test('a row without a track stays without one', () => {
  expect(rewriteActivityPath({ id: 'icu:i1', gpx_path: '' }, '/new/files/activities').gpx_path).toBe('');
  expect(rewriteActivityPath({ id: 'icu:i1', gpx_path: null }, '/new/files/activities').gpx_path).toBe('');
});
