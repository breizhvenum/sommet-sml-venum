// SML (Moveslink2 / Sommet) -> GPX 1.1. Pure text work, no native code: the .sml is the log of a
// move in the Moveslink2 layout (positions in radians, UTC per sample), and this rebuilds a track
// from it - one <trkpt> per position sample (gps-base and gps-small), with the exact UTC the
// watch recorded, the altitude, the speed and, when the SML has them, heart rate and cadence.
//
// It scans with indexOf rather than parsing the whole document: a move is ~6 MB of XML and
// building a DOM of it on a phone would be slow and memory hungry.

import RNFS from 'react-native-fs';

const DEG = 180 / Math.PI;

function tagText(block: string, name: string): string | null {
  const open = block.indexOf(`<${name}>`);
  if (open < 0) return null;
  const from = open + name.length + 2;
  const close = block.indexOf(`</${name}>`, from);
  if (close < 0) return null;
  return block.substring(from, close);
}

function num(block: string, name: string): number | null {
  const t = tagText(block, name);
  if (t == null) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** ISO UTC with a "Z" and no needless fraction: "2026-10-25T15:20:13Z" / "...12.794Z". */
function isoUtc(u: string): string {
  const t = u.trim();
  return t.endsWith('Z') ? t : t + 'Z';
}

export interface SmlGpxResult { gpx: string; points: number }

export function smlToGpx(xml: string): SmlGpxResult {
  const activity = (tagText(xml, 'Activity') ?? '').trim();
  const pts: string[] = [];
  let firstTime = '';
  let ele: number | null = null;       // last GPS altitude seen
  let speed: number | null = null;     // last speed seen (m/s)
  let hr: number | null = null;        // beats per minute
  let cad: number | null = null;       // revolutions per minute

  let pos = 0;
  for (;;) {
    const a = xml.indexOf('<Sample>', pos);
    if (a < 0) break;
    const b = xml.indexOf('</Sample>', a);
    if (b < 0) break;
    pos = b + 9;
    const block = xml.substring(a, b);
    const type = tagText(block, 'SampleType');

    if (type === 'periodic') {
      const sp = num(block, 'Speed'); if (sp != null) speed = sp;
      const h = num(block, 'HR'); if (h != null) hr = Math.round(h * 60);
      const c = num(block, 'Cadence'); if (c != null) cad = Math.round(c * 60);
      continue;
    }
    if (type !== 'gps-base' && type !== 'gps-small' && type !== 'gps-tiny') continue;

    const lat = num(block, 'Latitude'), lon = num(block, 'Longitude');
    const utc = tagText(block, 'UTC');
    if (lat == null || lon == null || !utc) continue;
    if (lat === 0 && lon === 0) continue;
    if (type === 'gps-base') {
      const alt = num(block, 'GPSAltitude'); if (alt != null) ele = alt;
      const gs = num(block, 'GPSSpeed'); if (gs != null) speed = gs;
    }
    const time = isoUtc(utc);
    if (!firstTime) firstTime = time;

    let ext = '';
    if (speed != null) ext += `<speed>${speed.toFixed(2)}</speed>`;
    if (hr != null || cad != null) {
      ext += '<gpxtpx:TrackPointExtension>';
      if (hr != null) ext += `<gpxtpx:hr>${hr}</gpxtpx:hr>`;
      if (cad != null) ext += `<gpxtpx:cad>${cad}</gpxtpx:cad>`;
      ext += '</gpxtpx:TrackPointExtension>';
    }
    pts.push(
      `    <trkpt lat="${(lat * DEG).toFixed(7)}" lon="${(lon * DEG).toFixed(7)}">` +
      (ele != null ? `<ele>${ele.toFixed(1)}</ele>` : '') +
      `<time>${time}</time>` + (ext ? `<extensions>${ext}</extensions>` : '') + '</trkpt>',
    );
  }

  const gpx =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="Ambit Venum (from SML)" xmlns="http://www.topografix.com/GPX/1/1"' +
    ' xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n' +
    (firstTime ? `  <metadata><time>${firstTime}</time></metadata>\n` : '') +
    `  <trk><name>${esc(activity)}</name>\n  <trkseg>\n` + pts.join('\n') + '\n  </trkseg></trk>\n</gpx>\n';
  return { gpx, points: pts.length };
}

/** Reads the .sml at `smlPath`, converts it and writes the GPX to the cache; returns its path. */
export async function convertSmlFileToGpx(smlPath: string, baseName: string): Promise<{ path: string; points: number }> {
  const xml = await RNFS.readFile(smlPath, 'utf8');
  const { gpx, points } = smlToGpx(xml);
  if (points === 0) throw new Error('No GPS position in this SML');
  const path = `${RNFS.CachesDirectoryPath}/${baseName}.gpx`;
  await RNFS.writeFile(path, gpx, 'utf8');
  return { path, points };
}
