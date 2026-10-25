// Every sync sets the watch clock (🟣26), as the Suunto app does: after the activity read,
// before the step read, and a clock the watch refuses never fails the sync.
export {};   // a module: its mocks don't clash with the other test files' names

jest.mock('../devices/AmbitDeviceProvider', () => ({ ambitDeviceProvider: {} }));
jest.mock('../GpxService', () => ({ writeGpxFile: jest.fn(), writeFitFile: jest.fn() }));
jest.mock('../GpxParser', () => ({ extractGpxMetadata: jest.fn(() => ({})) }));
jest.mock('../MarkSynced', () => ({ isMarkSyncedEnabled: jest.fn(async () => false) }));
jest.mock('../GearAutoAssign', () => ({ attributeMoveToGear: jest.fn() }));
jest.mock('../../database/db', () => ({
  isActivitySynced: jest.fn(async () => false),
  isActivityDeleted: jest.fn(async () => false),
  markActivitySynced: jest.fn(),
  getAllSyncedIds: jest.fn(async () => []),
  clearDeletedActivities: jest.fn(),
  rejectJunkActivity: jest.fn(async () => false),
}));

const { runSync } = require('../SyncService') as typeof import('../SyncService');

function watch(clock: () => Promise<boolean>) {
  const log: string[] = [];
  const provider = {
    deviceName: 'test',
    connect: async () => { log.push('connect'); return { name: 'Suunto Ambit3 Peak', vendorId: 0x1493, productId: 0x1c }; },
    disconnect: async () => { log.push('disconnect'); },
    getLogs: async () => { log.push('logs'); return []; },
    onSyncProgress: () => () => {},
    syncDailySteps: async () => { log.push('steps'); return 0; },
    setClock: async () => { log.push('clock'); return clock(); },
  };
  return { log, provider };
}

test('the clock is set after the activities and before the steps', async () => {
  const { log, provider } = watch(async () => true);
  const states: string[] = [];
  await runSync(s => states.push(s.phase), provider);
  expect(log).toEqual(['connect', 'logs', 'clock', 'steps', 'disconnect']);
  expect(states[states.length - 1]).toBe('done');
});

test('a clock the watch refuses does not fail the sync', async () => {
  const { log, provider } = watch(async () => { throw new Error('TIME_SYNC_FAILED'); });
  const states: string[] = [];
  await runSync(s => states.push(s.phase), provider);
  expect(log).toEqual(['connect', 'logs', 'clock', 'steps', 'disconnect']);
  expect(states).not.toContain('error');
  expect(states[states.length - 1]).toBe('done');
});

test('a watch without a clock step syncs as before', async () => {
  const { log, provider } = watch(async () => true);
  const { setClock: _unused, ...noClock } = provider;
  await runSync(() => {}, noClock);
  expect(log).toEqual(['connect', 'logs', 'steps', 'disconnect']);
});
