// Every sport-mode write first saves what the watch held, and a write without that copy does
// not happen (CustomModesBackup.ts, AmbitUsbModule.writeCustomModesRaw).

const mockFiles = new Map<string, string>();
const mockLog: string[] = [];
const mockFs = {
  failWrites: false,
};

jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/files',
  mkdir: jest.fn(async () => {}),
  writeFile: jest.fn(async (path: string, data: string) => {
    if (mockFs.failWrites) throw new Error('disk full');
    mockLog.push(`backup ${data}`);
    mockFiles.set(path, data);
  }),
  readDir: jest.fn(async (dir: string) => [...mockFiles.keys()]
    .filter(k => k.startsWith(`${dir}/`))
    .map(k => ({ path: k, name: k.slice(dir.length + 1), isFile: () => true }))),
  unlink: jest.fn(async (path: string) => { mockFiles.delete(path); }),
}));

const mockNative = {
  readCustomModesRaw: jest.fn(async () => { mockLog.push('read'); return 'AAAA'; }),
  writeCustomModesRaw: jest.fn(async (b64: string) => { mockLog.push(`write ${b64}`); return true; }),
  getDeviceInfo: jest.fn(async () => ({ serial: '8A153C5111000900' })),
};

jest.mock('react-native', () => ({
  NativeModules: { AmbitUsbModule: mockNative },
  NativeEventEmitter: class { addListener() { return { remove() {} }; } },
  Platform: { OS: 'android' },
}));

// Loaded after the mocks above exist (an import would run before them).
const { backupCustomModes, backupPath, KEEP, BACKUP_ROOT } =
  require('../CustomModesBackup') as typeof import('../CustomModesBackup');
const { readCustomModesRaw, writeCustomModesRaw } =
  require('../../native/AmbitUsbModule') as typeof import('../../native/AmbitUsbModule');

beforeEach(() => {
  mockFiles.clear();
  mockLog.length = 0;
  mockFs.failWrites = false;
  jest.clearAllMocks();
});

test('a backup is named by watch and time, and the names sort by time', () => {
  const a = backupPath('8A15/3C', new Date('2026-10-24T21:30:15.123Z'));
  const b = backupPath('8A15/3C', new Date('2026-10-24T21:30:15.124Z'));
  expect(a).toBe(`${BACKUP_ROOT}/8A15_3C/CustomModes_pre_20261024T213015123Z.bin`);
  expect(a < b).toBe(true);
});

test(`only the newest ${KEEP} backups of a watch are kept`, async () => {
  const start = Date.UTC(2026, 9, 24);
  for (let i = 0; i < KEEP + 5; i++) await backupCustomModes(`IMG${i}`, 'W1', new Date(start + i * 1000));
  const kept = [...mockFiles.values()];
  expect(kept).toHaveLength(KEEP);
  expect(kept).not.toContain('IMG4');
  expect(kept).toContain('IMG5');
  expect(kept).toContain(`IMG${KEEP + 4}`);
});

test('a write saves what the watch held first, then writes', async () => {
  await readCustomModesRaw();
  expect(await writeCustomModesRaw('BBBB')).toBe(true);
  await writeCustomModesRaw('CCCC');
  expect(mockLog).toEqual(['read', 'backup AAAA', 'write BBBB', 'backup BBBB', 'write CCCC']);
});

test('no backup, no write', async () => {
  await readCustomModesRaw();
  mockFs.failWrites = true;
  await expect(writeCustomModesRaw('BBBB')).rejects.toThrow(/nothing was written/);
  expect(mockNative.writeCustomModesRaw).not.toHaveBeenCalled();
});
