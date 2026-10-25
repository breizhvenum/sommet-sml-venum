// Copies of watch data taken before Sommet changes it, like the desktop's backups/*_pre_*.bin:
// a bad write can be undone from the copy. Kept in the app's private files under
// backups/<kind>/<serial>/<kind>_pre_<time>.bin, the newest KEEP per watch and kind.

import RNFS from 'react-native-fs';

export const KEEP = 30;
export const BACKUPS_DIR = `${RNFS.DocumentDirectoryPath}/backups`;

const safe = (s: string) => (s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');

/** Where a copy of `serial`'s `kind` taken at `when` goes. Names sort by time. */
export function watchBackupPath(kind: string, serial: string, when: Date): string {
  const stamp = when.toISOString().replace(/[-:.]/g, '');   // 20261024T213015123Z
  return `${BACKUPS_DIR}/${kind}/${safe(serial)}/${kind}_pre_${stamp}.bin`;
}

/** Saves `dataBase64` and drops the oldest copies beyond KEEP. Throws if it could not be
 * saved: the caller must not write without it. Returns the file's path. */
export async function saveWatchBackup(kind: string, dataBase64: string, serial: string,
                                      when = new Date()): Promise<string> {
  const path = watchBackupPath(kind, serial, when);
  const dir = path.slice(0, path.lastIndexOf('/'));
  await RNFS.mkdir(dir);
  await RNFS.writeFile(path, dataBase64, 'base64');
  try {
    const files = (await RNFS.readDir(dir))
      .filter(f => f.isFile() && f.name.startsWith(`${kind}_pre_`))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
      await RNFS.unlink(old.path).catch(() => {});
    }
  } catch {
    // Pruning is housekeeping; the backup itself is saved.
  }
  return path;
}
