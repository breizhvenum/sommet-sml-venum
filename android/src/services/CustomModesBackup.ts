// A copy of the watch's sport modes (the 12 KB CustomModes region) before every write Sommet
// makes to it, like the desktop's backups/CustomModes_pre_*.bin. Android used to write with no
// copy at all, so a bad write could only be undone by setting the modes up again by hand.
//
// The image saved is the one the writer started from: the last one read from the watch (every
// writer reads the region, or uses the cache seeded by that read, before changing it).

import { BACKUPS_DIR, saveWatchBackup, watchBackupPath } from './WatchBackup';

export { KEEP } from './WatchBackup';
export const BACKUP_ROOT = `${BACKUPS_DIR}/CustomModes`;

/** Where a backup of `serial`'s sport modes taken at `when` goes. Names sort by time. */
export function backupPath(serial: string, when: Date): string {
  return watchBackupPath('CustomModes', serial, when);
}

/** Saves `imageBase64` and drops the oldest copies beyond KEEP. Throws if it could not be
 * saved: the caller must not write without it. Returns the file's path. */
export async function backupCustomModes(imageBase64: string, serial: string, when = new Date()): Promise<string> {
  if (!imageBase64) throw new Error('No sport-mode image to back up');
  return saveWatchBackup('CustomModes', imageBase64, serial, when);
}
