// A copy of the watch's sport modes (the 12 KB CustomModes region) before every write Sommet
// makes to it, like the desktop's backups/CustomModes_pre_*.bin. Android used to write with no
// copy at all, so a bad write could only be undone by setting the modes up again by hand.
//
// Kept in the app's private files, per watch serial, the newest KEEP of them. The image saved
// is the one the writer started from: the last one read from the watch (every writer reads the
// region, or uses the cache seeded by that read, before changing it).

import RNFS from 'react-native-fs';

export const KEEP = 30;
export const BACKUP_ROOT = `${RNFS.DocumentDirectoryPath}/backups/CustomModes`;

const safe = (s: string) => (s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');

/** Where a backup of `serial`'s sport modes taken at `when` goes. Names sort by time. */
export function backupPath(serial: string, when: Date): string {
  const stamp = when.toISOString().replace(/[-:.]/g, '');   // 20261024T213015123Z
  return `${BACKUP_ROOT}/${safe(serial)}/CustomModes_pre_${stamp}.bin`;
}

/** Saves `imageBase64` and drops the oldest copies beyond KEEP. Throws if it could not be
 * saved: the caller must not write without it. Returns the file's path. */
export async function backupCustomModes(imageBase64: string, serial: string, when = new Date()): Promise<string> {
  if (!imageBase64) throw new Error('No sport-mode image to back up');
  const path = backupPath(serial, when);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await RNFS.mkdir(dir);
  await RNFS.writeFile(path, imageBase64, 'base64');
  try {
    const files = (await RNFS.readDir(dir))
      .filter(f => f.isFile() && f.name.startsWith('CustomModes_pre_'))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
      await RNFS.unlink(old.path).catch(() => {});
    }
  } catch {
    // Pruning is housekeeping; the backup itself is saved.
  }
  return path;
}
