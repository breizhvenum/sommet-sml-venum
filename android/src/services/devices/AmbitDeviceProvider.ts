// ─── AmbitDeviceProvider ──────────────────────────────────────────────────────
// Implémentation de DeviceProvider pour les montres Suunto Ambit.

import * as AmbitUsbModule from '../../native/AmbitUsbModule';
import { DeviceProvider, DeviceInfo } from './DeviceProvider';
import { SyncProgressEvent } from '../../native/AmbitUsbModule';
import { markReadLogsSynced } from '../MarkSynced';
import { syncWatchSteps } from '../AmbitSteps';

export class AmbitDeviceProvider implements DeviceProvider {
  readonly deviceName = 'Suunto Ambit';

  connect(): Promise<DeviceInfo> {
    return AmbitUsbModule.connect();
  }

  disconnect(): Promise<void> {
    return AmbitUsbModule.disconnect();
  }

  getLogs(knownIds: string[] = []): Promise<string[]> {
    return AmbitUsbModule.getLogs(knownIds);
  }

  getLogFits(): Promise<string[]> {
    return AmbitUsbModule.getLogFits();
  }

  getLogSmlFiles(dirPath: string): Promise<string[]> {
    return AmbitUsbModule.getLogSmlFiles(dirPath);
  }

  onSyncProgress(callback: (event: SyncProgressEvent) => void): () => void {
    return AmbitUsbModule.onSyncProgress(callback);
  }

  updateSgee(path: string): Promise<boolean> {
    return AmbitUsbModule.updateSgee(path);
  }

  markSyncedLogs(count: number): Promise<number> {
    return markReadLogsSynced(count);
  }

  syncDailySteps(): Promise<number> {
    return syncWatchSteps();
  }
}

export const ambitDeviceProvider = new AmbitDeviceProvider();
