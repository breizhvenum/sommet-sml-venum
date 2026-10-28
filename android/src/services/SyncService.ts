import { DeviceProvider } from './devices/DeviceProvider';
import { ambitDeviceProvider } from './devices/AmbitDeviceProvider';
import { writeGpxFile, writeFitFile, adoptSmlFile, clearSmlTmp, SML_TMP_DIR } from './GpxService';
import { readCustomModeNames, saveSmlStatus, withTimeout } from './SmlActivityNames';
import { extractGpxMetadata } from './GpxParser';
import { isActivitySynced, isActivityDeleted, markActivitySynced, getAllSyncedIds, clearDeletedActivities, rejectJunkActivity } from '../database/db';
import { isMarkSyncedEnabled } from './MarkSynced';
import { attributeMoveToGear } from './GearAutoAssign';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncState {
  phase: 'idle' | 'connecting' | 'fetching' | 'writing' | 'done' | 'error';
  current: number;
  total: number;
  newCount: number;   // logs effectivement écrits (nouveaux)
  error?: string;
  deviceName?: string; // nom du modèle détecté, ex. "Suunto Ambit3 Peak" (connu après connect())
}

type SyncListener = (state: SyncState) => void;

// ─── SyncService ──────────────────────────────────────────────────────────────

/**
 * Orchestre une synchronisation complète :
 *   connect → getLogs → (pour chaque log nouveau) writeGpx → markSynced → disconnect
 *
 * @param onState  Callback appelé à chaque changement d'état
 * @param provider DeviceProvider à utiliser (par défaut : Suunto Ambit)
 * @returns        Nombre de nouveaux logs écrits
 */
export async function runSync(
  onState: SyncListener,
  provider: DeviceProvider = ambitDeviceProvider,
  opts: { forceRefresh?: boolean; reimportForFit?: boolean } = {},
): Promise<number> {
  // forceRefresh (André, 2026-08-30): re-read and OVERWRITE the GPX of activities already on the
  // phone — so a decode fix (e.g. the trekking "no GPS data" periodic-sample fix) reaches moves
  // that were synced before it. The watch is an immutable logbook that re-sends everything, so we
  // just skip the deleted blacklist instead of every already-synced id, and overwrite on write.
  // Deleted activities are still never resurrected (isActivityDeleted guard below).
  //
  // reimportForFit (2026-09-14): a one-time re-read after upgrading to the native-FIT build, so
  // every move still on the watch gets its <id>.fit rebuilt (with hr/power/etc.) - existing moves
  // never stored those channels on the phone, only the GPS track. Same re-read+overwrite as
  // forceRefresh, but it must NOT resurrect user-deleted moves, so it leaves the deleted
  // blacklist intact (only forceRefresh clears it).
  const reReadAll = !!opts.forceRefresh || !!opts.reimportForFit;
  const refresh = reReadAll || !!provider.refreshExisting;
  const emit = (partial: Partial<SyncState> & { phase: SyncState['phase'] }) =>
    onState({ current: 0, total: 0, newCount: 0, ...partial });

  // ── 1. Connexion ────────────────────────────────────────────────────────────
  emit({ phase: 'connecting' });
  let deviceName: string | undefined;
  try {
    const info = await provider.connect();
    deviceName = info.name;
  } catch (e: any) {
    emit({ phase: 'error', error: e?.message ?? 'Connection failed' });
    return 0;
  }

  // ── 2. Récupération des logs ─────────────────────────────────────────────────
  emit({ phase: 'fetching', current: 0, total: 0, deviceName });

  // Charger les IDs déjà connus → passés au skip_callback natif pour éviter
  // de relire le payload complet des logs déjà synchronisés
  // On a forced refresh, empty the deleted blacklist first (so a move removed by mistake comes
  // back) and treat NOTHING as known, so the watch re-sends every activity; otherwise skip
  // everything already synced.
  if (opts.forceRefresh) await clearDeletedActivities();
  const knownIds = reReadAll ? [] : await getAllSyncedIds();

  let current = 0;
  let total = 0;
  const unsubscribe = provider.onSyncProgress(event => {
    current = event.current;
    total = event.total;
    onState({ phase: 'fetching', current, total, newCount: 0, deviceName });
  });

  let gpxLogs: string[];
  try {
    gpxLogs = await provider.getLogs(knownIds);
  } catch (e: any) {
    unsubscribe();
    emit({ phase: 'error', error: e?.message ?? 'Failed to read logs' });
    await provider.disconnect().catch(() => {});
    return 0;
  }
  unsubscribe();

  // Native FIT of each move (same order/indices as gpxLogs), built at sync time from the raw
  // samples: outdoor = GPS track + HR/cadence/speed/power/temperature, indoor = those sensor
  // channels with no track (so indoor/home-trainer moves export to FIT too - they have no GPX
  // track for the on-export GPX->FIT path to use). "" for a move with no FIT. Best-effort: if
  // the provider can't build FIT natively, or the call fails, we just skip writing .fit files
  // and the export screen falls back to converting the GPX.
  let fitLogs: string[] = [];
  if (provider.getLogFits) {
    try {
      fitLogs = await provider.getLogFits();
    } catch (e: any) {
      console.log('[sync] native FIT fetch failed, will fall back to GPX->FIT on export:', e?.message ?? e);
    }
  }

  // Moveslink2-style SML of each move (same indices as gpxLogs), written by the native layer to
  // temp files and moved next to the GPX below. Best-effort: a failure only means no .sml export.
  let smlLogs: string[] = [];
  const smlNotes: string[] = [`logs=${gpxLogs.length}`, `fits=${fitLogs.filter(Boolean).length}`];
  if (provider.getLogSmlFiles) {
    let modeNames: Record<string, string> = {};
    try {
      modeNames = await withTimeout(readCustomModeNames(), 8000, 'sport-mode names');
      smlNotes.push(`modeNames=${Object.keys(modeNames).length}`);
    } catch (e: any) {
      smlNotes.push(`modeNames FAILED: ${e?.message ?? e}`);
    }
    try {
      smlLogs = await provider.getLogSmlFiles(SML_TMP_DIR, modeNames);
    } catch (e: any) {
      smlNotes.push(`getLogSmlFiles FAILED: ${e?.message ?? e}`);
      try {   // retry without names in case that argument is what broke it
        smlLogs = await provider.getLogSmlFiles(SML_TMP_DIR, {});
        smlNotes.push('retry without names OK');
      } catch (e2: any) {
        smlNotes.push(`retry FAILED: ${e2?.message ?? e2}`);
      }
    }
    smlNotes.push(`smlFiles=${smlLogs.length} nonEmpty=${smlLogs.filter(Boolean).length}`);
  } else {
    smlNotes.push('this device provider has NO getLogSmlFiles');
  }
  let smlWritten = 0;
  const smlErrors: string[] = [];

  // ── 2b. Mark-synced write-back (experimental Settings toggle, OFF by default) ──
  // The moves in gpxLogs are exactly the ones read this session (the watch skipped the
  // already-known ones), so their indices match the native cache 0..gpxLogs.length-1. Tell
  // the watch they're synced so the Suunto app / SuuntoLink don't duplicate them. Best-effort
  // and non-fatal: a failure here must never lose the moves the user just read. Only the
  // Ambit providers implement markSyncedLogs, and it no-ops on unsupported watches.
  if (provider.markSyncedLogs && (await isMarkSyncedEnabled())) {
    try {
      await provider.markSyncedLogs(gpxLogs.length);
    } catch (e: any) {
      console.log('[mark-synced] write-back failed, moves still returned:', e?.message ?? e);
    }
  }

  // ── 2c. Daily steps (Ambit3) ─────────────────────────────────────────────────
  // The watch keeps only 30 days of step counts; each sync stores what it has, for the Health
  // screen. Best-effort and silent: it never fails the sync.
  if (provider.syncDailySteps) {
    const n = await provider.syncDailySteps();
    if (n > 0) console.log(`[steps] ${n} day(s) of steps read from the watch`);
  }

  // ── 3. Écriture des nouveaux logs ────────────────────────────────────────────
  emit({ phase: 'writing', current: 0, total: gpxLogs.length, newCount: 0, deviceName });
  let newCount = 0;

  for (let i = 0; i < gpxLogs.length; i++) {
    const gpxXml = gpxLogs[i];

    const meta = extractGpxMetadata(gpxXml);
    const id = meta.date
      ? meta.date.replace(/[^0-9T]/g, '').substring(0, 15) // "20240615T093000"
      : `log_${Date.now()}_${i}`;

    onState({ phase: 'writing', current: i + 1, total: gpxLogs.length, newCount, deviceName });

    // A live re-read device (Kailash) refreshes existing activities so a re-sync adopts a
    // better decode; an immutable logbook (Ambit3) skips ones already synced. Either way a
    // user-DELETED activity is never resurrected.
    if (await isActivityDeleted(id)) continue;
    if (!refresh && await isActivitySynced(id)) continue;
    // Junk/test entries (under a minute AND under 100 m) are not kept - same rule as the desktop.
    if (await rejectJunkActivity(id, meta.durationS, meta.distanceM)) continue;

    const gpxPath = await writeGpxFile(id, gpxXml, refresh);
    if (!gpxPath) continue;

    // Persist the native FIT next to the GPX (best-effort; index-aligned with gpxLogs). Written
    // whenever we're writing this move's GPX, so the two never drift.
    if (fitLogs[i]) {
      try {
        await writeFitFile(id, fitLogs[i], refresh);
      } catch (e: any) {
        console.log(`[sync] .fit write failed for ${id}, GPX still saved:`, e?.message ?? e);
      }
    }

    // The Moveslink2-style .sml, next to the GPX/FIT (best-effort, index-aligned with gpxLogs).
    if (smlLogs[i]) {
      try {
        if (await adoptSmlFile(id, smlLogs[i], refresh)) smlWritten++;
      } catch (e: any) {
        smlErrors.push(`${id}: ${e?.message ?? e}`);
        console.log(`[sync] .sml write failed for ${id}, GPX still saved:`, e?.message ?? e);
      }
    }

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
    // Attribute this move to its default gear in the local usage ledger (best-effort) so the app
    // tallies gear mileage itself — the step toward not needing intervals.icu (GearTotals).
    await attributeMoveToGear(id, meta.activityType, meta.distanceM, meta.durationS, meta.date);
    newCount++;
  }

  await clearSmlTmp();
  smlNotes.push(`smlWritten=${smlWritten}`, `newMoves=${newCount}`);
  if (smlErrors.length) smlNotes.push(`writeErrors: ${smlErrors.slice(0, 2).join(' | ')}`);
  await saveSmlStatus(smlNotes.join(' ; '));

  // ── 4. Déconnexion ───────────────────────────────────────────────────────────
  await provider.disconnect().catch(() => {});
  emit({ phase: 'done', current: gpxLogs.length, total: gpxLogs.length, newCount, deviceName });
  return newCount;
}
