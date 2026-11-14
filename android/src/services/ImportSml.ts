import RNFS from 'react-native-fs';
import { pickGpxFile, pickSmlFolder } from '../native/AmbitUsbModule';
import { smlToGpx } from './SmlToGpx';
import { extractGpxMetadata } from './GpxParser';
import { writeGpxFile, adoptSmlFile } from './GpxService';
import { isActivitySynced, isActivityDeleted, markActivitySynced } from '../database/db';
import { attributeMoveToGear } from './GearAutoAssign';
import { isFrench as __isFr } from '../i18n';
function L(fr: string, en: string): string { return __isFr ? fr : en; } // hoisted: safe to use at module level

export type ImportSmlResult =
  | { status: 'imported'; id: string; distanceM: number; durationS: number }
  | { status: 'exists'; id: string }
  | { status: 'deleted'; id: string };

/**
 * Adds a move from a Moveslink2-style .sml the user saved (the watch no longer holds it). Same
 * path as a sync: GPX built from the SML, the .sml kept next to it, the move recorded in the
 * local list with the same id a sync would give it (so a later sync never duplicates it).
 * Throws a readable Error when the file is not a usable SML.
 */
export async function importSmlActivity(): Promise<ImportSmlResult> {
  const picked = await pickGpxFile();   // rejects GPX_PICK_CANCELLED when the user backs out
  return importSmlFromPath(picked);
}

/** Same import for every .sml found in a folder the user picks (Moveslink2's, say). */
export async function importSmlFolder(): Promise<{ imported: number; exists: number; deleted: number; failed: number; total: number }> {
  const paths = await pickSmlFolder();   // rejects GPX_PICK_CANCELLED when the user backs out
  const res = { imported: 0, exists: 0, deleted: 0, failed: 0, total: paths.length };
  for (const p of paths) {
    try {
      const r = await importSmlFromPath(p);
      if (r.status === 'imported') res.imported++; else if (r.status === 'exists') res.exists++; else res.deleted++;
    } catch { res.failed++; }
    if (await RNFS.exists(p).catch(() => false)) await RNFS.unlink(p).catch(() => {});   // temp copy not adopted
  }
  return res;
}

async function importSmlFromPath(picked: string): Promise<ImportSmlResult> {
  const xml = await RNFS.readFile(picked, 'utf8');
  if (!/<sml[\s>]/i.test(xml)) throw new Error(L('Ce fichier n\'est pas un SML.', 'This file is not a SML.'));

  const { gpx, points } = smlToGpx(xml);
  if (points === 0) throw new Error('Ce SML ne contient aucune trace GPS.');

  const meta = extractGpxMetadata(gpx);
  if (!meta.date) throw new Error('Date de la session introuvable dans ce SML.');
  const id = meta.date.replace(/[^0-9T]/g, '').substring(0, 15);   // same rule as SyncService

  if (await isActivityDeleted(id)) return { status: 'deleted', id };
  if (await isActivitySynced(id)) return { status: 'exists', id };

  const gpxPath = await writeGpxFile(id, gpx, false);
  if (!gpxPath) return { status: 'exists', id };
  await adoptSmlFile(id, picked, true);   // moves the picked cache copy next to the GPX as <id>.sml

  await markActivitySynced({
    id,
    synced_at: Date.now(),
    gpx_path: gpxPath,
    date: meta.date,
    duration_s: meta.durationS,
    distance_m: meta.distanceM,
    d_plus: meta.dPlus,
    activity_type: meta.activityType,
  });
  await attributeMoveToGear(id, meta.activityType, meta.distanceM, meta.durationS, meta.date);
  return { status: 'imported', id, distanceM: meta.distanceM, durationS: meta.durationS };
}
