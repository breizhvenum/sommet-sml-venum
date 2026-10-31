/* eslint-disable */
// Speed analysis of a session, ported from the user's analyzer "analysegpsarpro16" (GPSAR Pro method),
// so the app shows the same numbers. Computation only (no DOM): Andoyer-Lambert distances, windows on
// real points, Doppler (watch <Speed>) integration, the cascade of ceilings (Vmax >= V10s, V100m >= V500m...),
// alphas (jibes only, wind from the track and, if reachable, Open-Meteo) and the manoeuvre stats.
// The manual wind choice / inversion / alpha verification of the analyzer are not part of this port.

const KNOTS_CONVERSION = 1.94384;
const DOPPLER_MIN_COVERAGE = 0.8;
const PLANNING_SPEED = 12;
const WIND_STEP_DEG = 5;
const MAX_CAP_STD = 15;
const VMAX_DELTA_KTS = 2.45;
const VMAX_ISOLATED_RATIO = 1.20;
const RAD_TO_DEG = 180 / Math.PI;
const SML_SPEED_MATCH_MS = 1500;
const POS_MIN_POINTS = 5;
const POS_MAX_GAP_S = 5;
const POS_MAX_CAP_STD = 15;
const POS_V10S_PIVOT_KTS = 19.44;
const POS_V10S_ISOLATED_RATIO = 1.20;
const FILTRE_ACCEL_DEFAUT = 1.8;
const FILTRE_VMAX_DEFAUT = 40;
const GEO_A = 6378135;
const GEO_F = 1 / 298.26;
const GAP_MAX_S = 30;
const ALPHA_PROXIMITE_M = 50;
const UN_RESULTAT_PAR_BORD = true;
const RUN_MIN_SPEED_KTS = 8;
const RUN_MAX_CAP_DELTA = 100;
const QUALITE_SAT_MIN = 5, QUALITE_HDOP_MAX = 4, QUALITE_MAX_RETRAIT = 0.10;
const GPSAR_D_WINDOW = 50;
const GPSAR_START_MIN = 5.14;
const SEUIL_REUSSITE = 6;
const GPSAR_MAX_WIDTH = 95;
const GPSAR_EXAM_MIN = 2;

export interface SpeedRange { tStart: number; tEnd: number }
export interface SpeedStats {
  date: number;            // first point time (ms)
  durationMs: number;
  distanceM: number;
  useDoppler: boolean;
  vmax: number; v10s: number; top5x10s: number;
  v100m: number; v500m: number; v1000m: number; v1852m: number; v5000m: number; v10000m: number;
  a250: number; a500: number;
  turns: number; jibes: number; tacks: number;
  vminJibe: number | null; vminTack: number | null; moyJibe: number | null; moyTack: number | null;
  nJibe: number; nTack: number;
  windDir: number | null; windSource: string; windSure: boolean;
  ranges: Record<string, SpeedRange[]>;
}

// ───────────────────────── reading ─────────────────────────
function lireDate(txt: any): number {
  if (txt === null || txt === undefined) return NaN;
  const str = String(txt).trim();
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (!m) return new Date(str).getTime();
  const ms = m[7] ? Math.round(parseFloat('0.' + m[7]) * 1000) : 0;
  if (!m[8]) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  if (m[8].toUpperCase() !== 'Z') {
    const sg = m[8][0] === '-' ? -1 : 1, hh = +m[8].slice(1, 3), mm = +m[8].slice(-2);
    t -= sg * (hh * 60 + mm) * 60000;
  }
  return t;
}
const lireNombre = (t: any): number | null => { if (t === null || t === undefined) return null; const v = parseFloat(String(t).trim()); return isFinite(v) ? v : null; };

// Plain indexOf scans (no regular expressions): on a phone's JS engine a regex over a multi-MB SML is very slow.
function tag(block: string, name: string): string | null {
  const open = '<' + name + '>';
  const a = block.indexOf(open);
  if (a < 0) return null;
  const from = a + open.length;
  const b = block.indexOf('</' + name + '>', from);
  if (b < 0) return null;
  const v = block.substring(from, b);
  return v.indexOf('<') >= 0 ? null : v;   // same as the former [^<]* match
}

/** Points (lat, lon, time, dopplerSpeed m/s, sat) read from a Suunto SML, same rules as the analyzer. */
export function readSmlPoints(smlText: string): any[] {
  if (smlText.indexOf('<sml') < 0) throw new Error('not an SML');
  const h0 = smlText.indexOf('<Header>'), h1 = h0 >= 0 ? smlText.indexOf('</Header>', h0) : -1;
  const debutLocal = h0 >= 0 && h1 > h0 ? lireDate(tag(smlText.substring(h0, h1), 'DateTime')) : NaN;
  const samples: string[] = [];
  for (let pos = 0; ;) {
    const a = smlText.indexOf('<Sample>', pos);
    if (a < 0) break;
    const b = smlText.indexOf('</Sample>', a);
    if (b < 0) break;
    samples.push(smlText.substring(a + 8, b));
    pos = b + 9;
  }
  const tempsSample = (s: string) => {
    const u = tag(s, 'UTC');
    if (u !== null) { const t = lireDate(u); if (isFinite(t)) return t; }
    const tn = tag(s, 'Time');
    const sec = tn !== null ? parseFloat(tn) : NaN;
    return (isFinite(debutLocal) && isFinite(sec)) ? debutLocal + sec * 1000 : NaN;
  };
  const periodicSpeeds: { t: number; v: number }[] = [];
  for (const s of samples) {
    const sp = tag(s, 'Speed');
    if (sp === null) continue;
    const type = tag(s, 'SampleType') ?? '';
    if (type && type !== 'periodic') continue;
    const t = tempsSample(s), v = parseFloat(sp);
    if (isNaN(t) || isNaN(v) || v < 0) continue;
    periodicSpeeds.push({ t, v });
  }
  periodicSpeeds.sort((a, b) => a.t - b.t);
  const raw: any[] = [];
  let pIdx = 0;
  for (const s of samples) {
    const la = tag(s, 'Latitude'), lo = tag(s, 'Longitude');
    if (la === null || lo === null) continue;
    const lat = parseFloat(la) * RAD_TO_DEG, lon = parseFloat(lo) * RAD_TO_DEG;
    if (isNaN(lat) || isNaN(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const time = tempsSample(s);
    if (isNaN(time)) continue;
    let speedMs: number | null = null;
    while (pIdx < periodicSpeeds.length - 1 && periodicSpeeds[pIdx + 1].t <= time) pIdx++;
    let bestDiff = Infinity, bestSpeed: number | null = null;
    for (let k = pIdx; k <= pIdx + 1 && k < periodicSpeeds.length; k++) {
      const diff = Math.abs(periodicSpeeds[k].t - time);
      if (diff < bestDiff) { bestDiff = diff; bestSpeed = periodicSpeeds[k].v; }
    }
    if (bestDiff <= SML_SPEED_MATCH_MS) speedMs = bestSpeed;
    if (speedMs === null) {
      const g = tag(s, 'GPSSpeed');
      if (g !== null) { const v = parseFloat(g); if (!isNaN(v) && v >= 0) speedMs = v; }
    }
    raw.push({ lat, lon, time, dopplerSpeed: speedMs, sat: lireNombre(tag(s, 'NumberOfSatellites')), hdop: null });
  }
  if (raw.length < 2) throw new Error('not enough GPS points');
  raw.sort((a, b) => a.time - b.time);
  const dedup = [raw[0]];
  for (let i = 1; i < raw.length; i++) if (raw[i].time > dedup[dedup.length - 1].time) dedup.push(raw[i]);
  if (dedup.length < 2) throw new Error('not enough GPS points');
  return dedup;
}

// ───────────────────────── geometry ─────────────────────────
function distGeo(p1: any, p2: any): number {
  if (p1.lat === p2.lat && p1.lon === p2.lon) return 0;
  const k = Math.PI / 180;
  const F = (p1.lat + p2.lat) / 2 * k, G = (p1.lat - p2.lat) / 2 * k, L = (p1.lon - p2.lon) / 2 * k;
  const sF = Math.sin(F), cF = Math.cos(F), sG = Math.sin(G), cG = Math.cos(G), sL = Math.sin(L), cL = Math.cos(L);
  const S = sG * sG * cL * cL + cF * cF * sL * sL;
  const C = cG * cG * cL * cL + sF * sF * sL * sL;
  if (S <= 0 || C <= 0) return 0;
  const w = Math.atan(Math.sqrt(S / C));
  const R = Math.sqrt(S * C) / w;
  const D = 2 * w * GEO_A;
  const H1 = (3 * R - 1) / (2 * C), H2 = (3 * R + 1) / (2 * S);
  return D * (1 + GEO_F * H1 * sF * sF * cG * cG - GEO_F * H2 * cF * cF * sG * sG);
}
const haversine = distGeo;
function bearing(p1: any, p2: any): number {
  const lat1 = p1.lat * Math.PI / 180, lat2 = p2.lat * Math.PI / 180, dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function angleDiff(a: number, b: number): number { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// ───────────────────────── windows ─────────────────────────
function indexParTemps(points: any[], t: number): number {
  let lo = 0, hi = points.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (points[m].time <= t) lo = m; else hi = m - 1; }
  return lo;
}
function etendueDuBord(points: any[], i: number, j: number) {
  const n = points.length;
  const vit = (k: number) => (points[k].speed !== null && points[k].speed !== undefined && !isNaN(points[k].speed)) ? points[k].speed : 0;
  const capFin = bearing(points[Math.max(j - 1, 0)], points[j]);
  let b = j;
  while (b + 1 < n && (points[b + 1].time - points[b].time) / 1000 <= GAP_MAX_S && vit(b + 1) >= RUN_MIN_SPEED_KTS
         && angleDiff(bearing(points[b], points[b + 1]), capFin) <= RUN_MAX_CAP_DELTA) b++;
  const capDebut = bearing(points[i], points[Math.min(i + 1, n - 1)]);
  let a = i;
  while (a - 1 >= 0 && (points[a].time - points[a - 1].time) / 1000 <= GAP_MAX_S && vit(a - 1) >= RUN_MIN_SPEED_KTS
         && angleDiff(bearing(points[a - 1], points[a]), capDebut) <= RUN_MAX_CAP_DELTA) a--;
  return { tStart: points[a].time, tEnd: points[b].time };
}
function preparerSegments(points: any[], useDoppler: boolean) {
  const n = points.length;
  const CD = new Float64Array(n), CDop = new Float64Array(n), blk = new Int32Array(n);
  let b = 0;
  for (let i = 1; i < n; i++) {
    const dt = (points[i].time - points[i - 1].time) / 1000;
    if (!(dt > 0) || dt > GAP_MAX_S) { b++; CD[i] = CD[i - 1]; CDop[i] = CDop[i - 1]; blk[i] = b; continue; }
    let d, dop = 0;
    const v0 = points[i - 1].dopplerSpeed, v1 = points[i].dopplerSpeed;
    const ok0 = v0 !== null && v0 !== undefined;
    if (useDoppler) { d = (ok0 ? v0 : 0) * dt; if (ok0) dop = dt; }
    else d = distGeo(points[i - 1], points[i]);
    void v1;
    CD[i] = CD[i - 1] + d; CDop[i] = CDop[i - 1] + dop; blk[i] = b;
  }
  return { CD, CDop, blk };
}
function fenetre(points: any[], seg: any, i: number, j: number): any {
  const dt = (points[j].time - points[i].time) / 1000;
  const d = seg.CD[j] - seg.CD[i];
  return { i, j, dt, d, cov: dt > 0 ? (seg.CDop[j] - seg.CDop[i]) / dt : 0, speed: dt > 0 ? (d / dt) * KNOTS_CONVERSION : 0, tStart: points[i].time, tEnd: points[j].time };
}
function listerFenetresDuree(points: any[], seg: any, seconds: number): any[] {
  const T = seconds * 1000, n = points.length, out: any[] = [];
  let j = 1;
  for (let i = 0; i < n - 1; i++) {
    if (j <= i) j = i + 1;
    while (j < n && points[j].time - points[i].time < T) j++;
    if (j >= n) break;
    if (seg.blk[j] !== seg.blk[i]) continue;
    out.push(fenetre(points, seg, i, j));
  }
  return out;
}
function listerFenetresDistance(points: any[], seg: any, meters: number): any[] {
  const n = points.length, out: any[] = [];
  let j = 1;
  for (let i = 0; i < n - 1; i++) {
    if (j <= i) j = i + 1;
    while (j < n && seg.CD[j] - seg.CD[i] < meters) j++;
    if (j >= n) break;
    if (seg.blk[j] !== seg.blk[i]) continue;
    const w = fenetre(points, seg, i, j);
    if (w.dt > 0) out.push(w);
  }
  return out;
}
const couvertureOk = (w: any, useDoppler: boolean) => !useDoppler || w.cov >= DOPPLER_MIN_COVERAGE;

const _cacheCaps = new WeakMap<any, any>();
function capsCumules(points: any[]) {
  let c = _cacheCaps.get(points);
  if (c) return c;
  const n = points.length, C = new Float64Array(n), Sn = new Float64Array(n), N = new Int32Array(n);
  for (let k = 0; k < n - 1; k++) {
    let dc = 0, ds = 0, dn = 0;
    if (points[k + 1].time > points[k].time) { const r = bearing(points[k], points[k + 1]) * Math.PI / 180; dc = Math.cos(r); ds = Math.sin(r); dn = 1; }
    C[k + 1] = C[k] + dc; Sn[k + 1] = Sn[k] + ds; N[k + 1] = N[k] + dn;
  }
  c = { C, S: Sn, N };
  _cacheCaps.set(points, c);
  return c;
}
function capsStats(points: any[], i: number, j: number) {
  const c = capsCumules(points);
  const n = c.N[j] - c.N[i];
  if (n === 0) return { n: 0, std: 0 };
  const mc = (c.C[j] - c.C[i]) / n, ms = (c.S[j] - c.S[i]) / n;
  const R = Math.sqrt(mc * mc + ms * ms);
  if (R >= 1) return { n, std: 0 };
  return { n, std: Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI };
}
const _cachePlan = new WeakMap<any, any>();
function planLocal(points: any[]) {
  let c = _cachePlan.get(points);
  if (c) return c;
  const n = points.length, X = new Float64Array(n), Y = new Float64Array(n);
  if (n) {
    const lat0 = points[0].lat, lon0 = points[0].lon, f = lat0 * Math.PI / 180;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f);
    const mLon = 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f);
    for (let k = 0; k < n; k++) { X[k] = (points[k].lon - lon0) * mLon; Y[k] = (points[k].lat - lat0) * mLat; }
  }
  c = { X, Y };
  _cachePlan.set(points, c);
  return c;
}
function procheDe(points: any[], i: number, j: number, R: number, c?: any): boolean {
  c = c || planLocal(points);
  const dx = c.X[j] - c.X[i], dy = c.Y[j] - c.Y[i], d2 = dx * dx + dy * dy;
  const hi = R * 1.03 + 0.5, lo = R * 0.97 - 0.5;
  if (d2 > hi * hi) return false;
  if (lo > 0 && d2 < lo * lo) return true;
  return distGeo(points[i], points[j]) <= R;
}
function filtresPositionnels(points: any[], w: any): boolean {
  if ((w.j - w.i + 1) < POS_MIN_POINTS) return false;
  for (let k = w.i; k < w.j; k++) if ((points[k + 1].time - points[k].time) / 1000 > POS_MAX_GAP_S) return false;
  const h = capsStats(points, w.i, w.j);
  if (h.n < 3) return false;
  return h.std <= POS_MAX_CAP_STD;
}

// ───────────────────────── cleaning ─────────────────────────
function frequenceHz(pts: any[]): number {
  const dts: number[] = [];
  for (let i = 1; i < pts.length && dts.length < 5000; i++) { const d = pts[i].time - pts[i - 1].time; if (d > 0) dts.push(d); }
  if (!dts.length) return 0;
  dts.sort((a, b) => a - b);
  return Math.round(1000 / dts[Math.floor(dts.length / 2)]);
}
function nettoyerPoints(points: any[]): any {
  if (points.length === 0) return { points: [], keptCount: 0, rawCount: 0 };
  const accelMax = FILTRE_ACCEL_DEFAUT;
  const vmaxMs = FILTRE_VMAX_DEFAUT / KNOTS_CONVERSION;
  if (frequenceHz(points) >= 2) return nettoyerPointsHautDebit(points, accelMax, vmaxMs);
  const cleaned = [points[0]];
  cleaned[0].speed = 0;
  let segmentStartIdx = 0;
  for (let i = 1; i < points.length; i++) {
    const pCurr = points[i], pPrev = cleaned[cleaned.length - 1];
    const dt = (pCurr.time - pPrev.time) / 1000;
    if (dt <= 0) continue;
    if (dt > 30) { pCurr.speed = 0; cleaned.push(pCurr); segmentStartIdx = cleaned.length - 1; continue; }
    const d = haversine(pPrev, pCurr);
    const vCurr = d / dt;
    if (vCurr > vmaxMs) continue;
    const isSegmentStart = (cleaned.length - 1 === segmentStartIdx);
    const accel = isSegmentStart ? 0 : (vCurr - (pPrev.speed || 0)) / dt;
    if (!isSegmentStart && Math.abs(accel) > accelMax) continue;
    pCurr.speed = vCurr;
    cleaned.push(pCurr);
  }
  return { points: cleaned, keptCount: cleaned.length, rawCount: points.length };
}
function filtrerQualiteGPS(points: any[]): any {
  const n = points.length;
  const avecSat = points.filter(p => p.sat !== null && p.sat !== undefined && isFinite(p.sat)).length;
  const avecHdop = points.filter(p => p.hdop !== null && p.hdop !== undefined && isFinite(p.hdop)).length;
  const res: any = { points, rawCount: n, retires: 0, applique: false, disponible: false };
  if (n === 0 || (avecSat < n * 0.5 && avecHdop < n * 0.5)) return res;
  res.disponible = true;
  const utiliserSat = avecSat >= n * 0.5, utiliserHdop = avecHdop >= n * 0.5;
  const mauvais = (p: any) => (utiliserSat && p.sat !== null && p.sat !== undefined && p.sat < QUALITE_SAT_MIN) ||
                              (utiliserHdop && p.hdop !== null && p.hdop !== undefined && p.hdop > QUALITE_HDOP_MAX);
  const gardes = points.filter(p => !mauvais(p));
  const retires = n - gardes.length;
  if (retires > n * QUALITE_MAX_RETRAIT) return res;
  res.points = gardes; res.retires = retires; res.applique = true;
  return res;
}
function nettoyerPointsHautDebit(points: any[], accelMax: number, vmaxMs: number): any {
  const cleaned = [points[0]];
  cleaned[0].speed = 0; cleaned[0]._v1 = 0;
  let segStart = 0;
  for (let i = 1; i < points.length; i++) {
    const pCurr = points[i], pPrev = cleaned[cleaned.length - 1];
    const dt = (pCurr.time - pPrev.time) / 1000;
    if (dt <= 0) continue;
    if (dt > 30) { pCurr.speed = 0; pCurr._v1 = 0; cleaned.push(pCurr); segStart = cleaned.length - 1; continue; }
    let r = cleaned.length - 1;
    while (r > segStart && pCurr.time - cleaned[r].time < 1000) r--;
    const pRef = cleaned[r];
    const dtR = (pCurr.time - pRef.time) / 1000;
    const v1 = haversine(pRef, pCurr) / dtR;
    if (v1 > vmaxMs) continue;
    const debutSegment = (r === segStart);
    const accel = debutSegment ? 0 : (v1 - (pRef._v1 || 0)) / dtR;
    if (!debutSegment && Math.abs(accel) > accelMax) continue;
    pCurr.speed = haversine(pPrev, pCurr) / dt;
    pCurr._v1 = v1;
    cleaned.push(pCurr);
  }
  return { points: cleaned, keptCount: cleaned.length, rawCount: points.length };
}

// ───────────────────────── Vmax, V10s, distance windows ─────────────────────────
function estPicIsole(points: any[], i: number, ratio = 1.20): boolean {
  const fen: number[] = [];
  for (let k = Math.max(0, i - 3); k <= Math.min(points.length - 1, i + 3); k++) {
    if (k === i) continue;
    const v = points[k].speed;
    if (v !== null && !isNaN(v)) fen.push(v);
  }
  if (fen.length < 3) return false;
  fen.sort((a, b) => a - b);
  const mediane = fen[Math.floor(fen.length / 2)];
  if (mediane <= 0) return false;
  return points[i].speed > mediane * ratio;
}
function getVmaxFiltree(points: any[], v10sSpeed: number, deltaKts: number): any {
  let vmaxBrute = 0, vmaxBrutePoint: any = null;
  for (let i = 0; i < points.length; i++) {
    const s = points[i].speed;
    if (s !== null && !isNaN(s) && s > vmaxBrute) { vmaxBrute = s; vmaxBrutePoint = points[i]; }
  }
  if (vmaxBrute === 0 || v10sSpeed <= 0) return { vmax: vmaxBrute, vmaxPoint: vmaxBrutePoint, vmaxBrute, filtered: false };
  const plafond = v10sSpeed + deltaKts;
  if (vmaxBrute <= plafond) return { vmax: vmaxBrute, vmaxPoint: vmaxBrutePoint, vmaxBrute, filtered: false };
  let best = 0, bestPoint: any = null;
  for (let i = 0; i < points.length; i++) {
    const s = points[i].speed;
    if (s === null || isNaN(s)) continue;
    if (s > plafond) continue;
    if (estPicIsole(points, i, VMAX_ISOLATED_RATIO)) continue;
    if (s > best) { best = s; bestPoint = points[i]; }
  }
  if (best === 0) return { vmax: vmaxBrute, vmaxPoint: vmaxBrutePoint, vmaxBrute, filtered: false };
  return { vmax: best, vmaxPoint: bestPoint, vmaxBrute, filtered: true, plafond };
}
function chercherFenetre10sPositionnelle(points: any[], plafondKts: number | null, rejeterPicsIsoles: boolean): any {
  const seg = preparerSegments(points, false);
  let candidates = listerFenetresDuree(points, seg, 10).filter(w => filtresPositionnels(points, w));
  if (candidates.length === 0) return null;
  if (rejeterPicsIsoles) {
    const centre = (c: any) => (c.tStart + c.tEnd) / 2;
    const valides: any[] = [];
    let lo = 0, hi = 0;
    for (let c = 0; c < candidates.length; c++) {
      const cT = centre(candidates[c]);
      while (lo < candidates.length && centre(candidates[lo]) < cT - 5000) lo++;
      while (hi < candidates.length && centre(candidates[hi]) <= cT + 5000) hi++;
      const voisines: number[] = [];
      for (let o = lo; o < hi; o++) if (o !== c) voisines.push(candidates[o].speed);
      if (voisines.length < 3) { valides.push(candidates[c]); continue; }
      voisines.sort((a, b) => a - b);
      const med = voisines[Math.floor(voisines.length / 2)];
      if (med <= 0 || candidates[c].speed <= med * POS_V10S_ISOLATED_RATIO) valides.push(candidates[c]);
    }
    if (valides.length > 0) candidates = valides;
  }
  let best: any = null;
  for (const c of candidates) {
    if (plafondKts !== null && c.speed > plafondKts) continue;
    if (!best || c.speed > best.speed) best = c;
  }
  return best ? { speed: best.speed, range: { tStart: best.tStart, tEnd: best.tEnd } } : null;
}
function recadrerV10sPositionnelle(v10sResult: any, v100mResult: any, points: any[]): any {
  const v10s = v10sResult.speed || 0, v100m = v100mResult.speed || 0;
  if (v10s <= 0 || v100m <= 0) return { result: v10sResult, corrected: false };
  const sousPivot = v100m < POS_V10S_PIVOT_KTS;
  const depasseV100m = v10s > v100m;
  const plafondVmax = v10s + VMAX_DELTA_KTS;
  if (!sousPivot && depasseV100m) {
    const plafond = Math.min(v100m, plafondVmax);
    const found = chercherFenetre10sPositionnelle(points, plafond, true);
    if (found) return { result: { speed: found.speed, ranges: [found.range] }, corrected: true };
    return { result: { speed: plafond, ranges: v10sResult.ranges }, corrected: true };
  }
  const plafondVmaxKts = Math.min(plafondVmax, sousPivot ? Infinity : v100m);
  const found = chercherFenetre10sPositionnelle(points, plafondVmaxKts, true);
  if (found) {
    if (found.speed < v10s - 0.01) return { result: { speed: found.speed, ranges: [found.range] }, corrected: true };
    return { result: v10sResult, corrected: false };
  }
  if (v10s > plafondVmaxKts) return { result: { speed: plafondVmaxKts, ranges: v10sResult.ranges }, corrected: true };
  return { result: v10sResult, corrected: false };
}
function chercherFenetreDureeSousPlafond(points: any[], seconds: number, plafondKts: number, useDoppler: boolean): any {
  const seg = preparerSegments(points, useDoppler);
  let best: any = null;
  for (const w of listerFenetresDuree(points, seg, seconds)) {
    if (!couvertureOk(w, useDoppler) || w.speed <= 0) continue;
    if (w.speed > plafondKts + 0.01) continue;
    if (!best || w.speed > best.speed) best = w;
  }
  return best ? { speed: best.speed, range: { tStart: best.tStart, tEnd: best.tEnd } } : null;
}
function chercherFenetreDistanceSousPlafond(points: any[], meters: number, plafondKts: number, useDoppler: boolean): any {
  const seg = preparerSegments(points, useDoppler);
  let best: any = null;
  for (const w of listerFenetresDistance(points, seg, meters)) {
    if (!couvertureOk(w, useDoppler) || w.speed <= 0) continue;
    if (w.speed > plafondKts + 0.01) continue;
    if (!best || w.speed > best.speed) best = w;
  }
  return best ? { speed: best.speed, range: { tStart: best.tStart, tEnd: best.tEnd } } : null;
}
function recadrerDistance(result: any, meters: number, plafondKts: number, points: any[], useDoppler: boolean): any {
  const speed = result.speed || 0, plafond = plafondKts || 0;
  if (speed <= 0 || plafond <= 0) return { result, corrected: false };
  if (speed <= plafond + 0.01) return { result, corrected: false };
  const found = chercherFenetreDistanceSousPlafond(points, meters, plafond, useDoppler);
  if (found) return { result: { speed: found.speed, ranges: [found.range] }, corrected: true };
  return { result: { speed: plafond, ranges: result.ranges }, corrected: true, plafonne: true };
}
function getBestSpeedWindow(points: any[], seconds: number, useDoppler: boolean): any {
  const seg = preparerSegments(points, useDoppler);
  let best: any = null;
  for (const w of listerFenetresDuree(points, seg, seconds)) {
    if (!couvertureOk(w, useDoppler)) continue;
    if (!useDoppler && !filtresPositionnels(points, w)) continue;
    if (!best || w.speed > best.speed) best = w;
  }
  return best ? { speed: best.speed, ranges: [{ tStart: best.tStart, tEnd: best.tEnd }] } : { speed: 0, ranges: [] };
}
function getBestSpeedDistance(points: any[], meters: number, useDoppler: boolean): any {
  const seg = preparerSegments(points, useDoppler);
  let best: any = null;
  for (const w of listerFenetresDistance(points, seg, meters)) {
    if (!couvertureOk(w, useDoppler)) continue;
    if (!best || w.speed > best.speed) best = w;
  }
  return best ? { speed: best.speed, ranges: [{ tStart: best.tStart, tEnd: best.tEnd }] } : { speed: 0, ranges: [] };
}
function getTopNAvgSpeedWindowSingleHeading(points: any[], seconds: number, n: number, useDoppler: boolean, v10sFilteredSpeed: number | null, v10sRange: any): any {
  const seg = preparerSegments(points, useDoppler);
  const candidates: any[] = [];
  for (const w of listerFenetresDuree(points, seg, seconds)) {
    const headings = capsStats(points, w.i, w.j);
    if (headings.n < 3) continue;
    if (headings.std > MAX_CAP_STD) continue;
    if (!couvertureOk(w, useDoppler) || w.speed <= 0) continue;
    if (!useDoppler && v10sFilteredSpeed !== null && v10sFilteredSpeed > 0 && w.speed > v10sFilteredSpeed + 0.01) continue;
    candidates.push({ speed: w.speed, tStart: w.tStart, tEnd: w.tEnd });
  }
  if (!useDoppler && v10sFilteredSpeed !== null && v10sFilteredSpeed > 0 && v10sRange) {
    let found = false;
    for (const c of candidates) {
      if (Math.abs(c.tStart - v10sRange.tStart) < 1 && Math.abs(c.tEnd - v10sRange.tEnd) < 1) { c.speed = v10sFilteredSpeed; found = true; break; }
    }
    if (!found) candidates.push({ speed: v10sFilteredSpeed, tStart: v10sRange.tStart, tEnd: v10sRange.tEnd });
  }
  if (candidates.length === 0) return { speed: 0, ranges: [] };
  candidates.sort((a, b) => b.speed - a.speed);
  const picked: any[] = [], bords: any[] = [];
  for (const c of candidates) {
    if (picked.length >= n) break;
    let overlaps = false;
    for (const p of picked) if (!(c.tEnd <= p.tStart || c.tStart >= p.tEnd)) { overlaps = true; break; }
    if (!overlaps && UN_RESULTAT_PAR_BORD) for (const b of bords) if (!(c.tEnd <= b.tStart || c.tStart >= b.tEnd)) { overlaps = true; break; }
    if (!overlaps) {
      picked.push(c);
      if (UN_RESULTAT_PAR_BORD) bords.push(etendueDuBord(points, indexParTemps(points, c.tStart), indexParTemps(points, c.tEnd)));
    }
  }
  if (picked.length === 0) return { speed: 0, ranges: [] };
  const sum = picked.reduce((s, c) => s + c.speed, 0);
  return { speed: sum / picked.length, ranges: picked.map(c => ({ tStart: c.tStart, tEnd: c.tEnd })) };
}
function distancesGeo(points: any[]): number[] {
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1] + distGeo(points[i - 1], points[i]));
  return d;
}
function pointsPourAlphas(points: any[], useDoppler: boolean, rawPoints: any[]): any[] {
  if (useDoppler) return points;
  const raw = filtrerQualiteGPS(rawPoints.map(p => ({ ...p }))).points;
  if (raw.length === 0) return raw;
  const vmaxMs = FILTRE_VMAX_DEFAUT / KNOTS_CONVERSION;
  const hautDebit = frequenceHz(raw) >= 2;
  const out = [raw[0]];
  let segStart = 0;
  for (let i = 1; i < raw.length; i++) {
    const prev = out[out.length - 1];
    const dt = (raw[i].time - prev.time) / 1000;
    if (dt <= 0) continue;
    if (dt > GAP_MAX_S) { out.push(raw[i]); segStart = out.length - 1; continue; }
    if (hautDebit) {
      let r = out.length - 1;
      while (r > segStart && raw[i].time - out[r].time < 1000) r--;
      if (distGeo(out[r], raw[i]) / ((raw[i].time - out[r].time) / 1000) > vmaxMs) continue;
    } else if (distGeo(prev, raw[i]) / dt > vmaxMs) continue;
    out.push(raw[i]);
  }
  return out;
}

// ───────────────────────── wind + alphas + manoeuvres ─────────────────────────
function moyenneCirc(liste: [number, number][]): { dir: number | null; r: number } {
  let c = 0, s = 0, w = 0;
  for (const [a, p] of liste) { c += Math.cos(a * Math.PI / 180) * p; s += Math.sin(a * Math.PI / 180) * p; w += p; }
  if (w <= 0) return { dir: null, r: 0 };
  return { dir: (Math.atan2(s, c) * 180 / Math.PI + 360) % 360, r: Math.hypot(c, s) / w };
}
function estimerVentTrace(points: any[]): any {
  const caps: [number, number][] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const sp = points[i].speed;
    if (sp === null || sp === undefined || sp < PLANNING_SPEED) continue;
    const d = distGeo(points[i], points[i + 1]);
    if (d < 1) continue;
    caps.push([bearing(points[i], points[i + 1]), d]);
  }
  if (caps.length < 20) return null;
  const axe2 = moyenneCirc(caps.map(([a, p]) => [(2 * a) % 360, p] as [number, number]));
  if (axe2.dir === null || axe2.r < 0.25) return null;
  const axe = axe2.dir / 2;
  const grpA: [number, number][] = [], grpB: [number, number][] = [];
  for (const c of caps) (angleDiff(c[0], axe) <= 90 ? grpA : grpB).push(c);
  const hA = moyenneCirc(grpA).dir, hB = moyenneCirc(grpB).dir;
  const w1 = (axe + 90) % 360, w2 = (axe + 270) % 360;
  let cote: number | null = null, confiance = 0;
  if (hA !== null && hB !== null) {
    const bis = moyenneCirc([[hA, 1], [hB, 1]]);
    confiance = bis.r;
    if (bis.dir !== null && confiance >= 0.12) cote = angleDiff(bis.dir, w1) < angleDiff(bis.dir, w2) ? w1 : w2;
  }
  return { candidats: [w1, w2], cote, confiance };
}
function analyserVirage(points: any[], i: number, j: number, windDir: number | null): any {
  const p0 = points[i], kx = Math.cos(p0.lat * Math.PI / 180);
  let tip = i + 1, dmax = -1;
  for (let k = i + 1; k < j; k++) {
    const dx = (points[k].lon - p0.lon) * kx, dy = points[k].lat - p0.lat, dd = dx * dx + dy * dy;
    if (dd > dmax) { dmax = dd; tip = k; }
  }
  const cap = bearing(points[Math.max(tip - 1, i)], points[Math.min(tip + 1, j)]);
  let vmin = Infinity;
  for (let k = i; k <= j; k++) if (points[k].speed !== null && points[k].speed !== undefined && points[k].speed < vmin) vmin = points[k].speed;
  return { tip, cap, empannage: windDir === null ? true : angleDiff(cap, windDir) > 90, vmin: isFinite(vmin) ? vmin : null };
}
function coteParVirages(points: any[], candidats: number[]): any {
  const n = points.length, D = new Float64Array(n);
  for (let i = 1; i < n; i++) D[i] = D[i - 1] + distGeo(points[i - 1], points[i]);
  let pour = 0, contre = 0, finPrec = -1, j0 = 1;
  const PL = planLocal(points), PX = PL.X, PY = PL.Y, LOIN2 = (ALPHA_PROXIMITE_M * 1.03 + 0.5) ** 2;
  for (let i = 0; i < n; i++) {
    if (i < finPrec) continue;
    if (j0 < i + 1) j0 = i + 1;
    while (j0 < n && D[j0] - D[i] < 150) j0++;
    for (let j = j0; j < n; j++) {
      const L = D[j] - D[i];
      if (L > 500) break;
      if (L < 150) continue;
      if ((points[j].time - points[i].time) / 1000 > 120) break;
      { const dx = PX[j] - PX[i], dy = PY[j] - PY[i]; if (dx * dx + dy * dy > LOIN2) continue; }
      if (!procheDe(points, i, j, ALPHA_PROXIMITE_M, PL)) continue;
      if (analyserVirage(points, i, j, candidats[0]).empannage) pour++; else contre++;
      finPrec = j; break;
    }
  }
  const total = pour + contre;
  if (total < 4) return null;
  return pour >= contre ? { cote: candidats[0], ratio: pour / total, total } : { cote: candidats[1], ratio: contre / total, total };
}
function estimerDirectionVent(points: any[], planningKnots = PLANNING_SPEED, pasDegres = WIND_STEP_DEG): number | null {
  if (!points || points.length < 2) return null;
  const nbSecteurs = Math.round(360 / pasDegres);
  const somme = new Array(nbSecteurs).fill(0), poids = new Array(nbSecteurs).fill(0);
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i], p2 = points[i + 1];
    if (p1.speed === null || p1.speed === undefined) continue;
    if (p1.speed < planningKnots) continue;
    const d = haversine(p1, p2);
    if (d < 1) continue;
    const az = bearing(p1, p2);
    const idx = Math.floor(az / pasDegres) % nbSecteurs;
    somme[idx] += p1.speed * d; poids[idx] += d;
  }
  const SEUIL_DIST = 50;
  let minMoyenne = Infinity, secteurMin: number | null = null;
  for (let s = 0; s < nbSecteurs; s++) { if (poids[s] < SEUIL_DIST) continue; const moy = somme[s] / poids[s]; if (moy < minMoyenne) { minMoyenne = moy; secteurMin = s; } }
  if (secteurMin === null) return null;
  let maxMoyenne = -Infinity, secteurMax: number | null = null;
  for (let s = 0; s < nbSecteurs; s++) { if (poids[s] < SEUIL_DIST) continue; const moy = somme[s] / poids[s]; if (moy > maxMoyenne) { maxMoyenne = moy; secteurMax = s; } }
  if (secteurMax === null) return (secteurMin + 0.5) * pasDegres;
  const capLent = (secteurMin + 0.5) * pasDegres, capRapide = (secteurMax + 0.5) * pasDegres;
  const perp1 = (capRapide + 90) % 360, perp2 = (capRapide + 270) % 360;
  let ventDe = (angleDiff(perp1, capLent) < angleDiff(perp2, capLent)) ? perp1 : perp2;
  if (angleDiff(capLent, ventDe) > 90) ventDe = (ventDe + 180) % 360;
  return ventDe;
}
export interface MeteoVent { dir: number; vitesse: number }
function choisirVent(points: any[], meteoDir: number | null): { dir: number | null; source: string; sur: boolean } {
  const geo = estimerVentTrace(points);
  const ancien = estimerDirectionVent(points, PLANNING_SPEED, WIND_STEP_DEG);
  const meteo = meteoDir;
  let res: any;
  if (geo) {
    const proche = (ref: number) => angleDiff(geo.candidats[0], ref) < angleDiff(geo.candidats[1], ref) ? geo.candidats[0] : geo.candidats[1];
    if (meteo !== null) {
      const c = proche(meteo);
      res = angleDiff(c, meteo) <= 60 ? { dir: c, source: 'trace + météo', sur: true } : { dir: meteo, source: 'météo (trace différente)', sur: false };
    } else {
      const vir = coteParVirages(points, geo.candidats);
      if (vir && vir.ratio >= 0.6) res = { dir: vir.cote, source: `trace (${Math.round(vir.ratio * 100)} % des demi-tours vent arrière)` + (vir.ratio >= 0.75 ? '' : ', à vérifier'), sur: vir.ratio >= 0.75 };
      else if (geo.cote !== null) res = { dir: geo.cote, source: 'trace, à vérifier', sur: false };
      else if (ancien !== null) res = { dir: proche(ancien), source: 'trace, à vérifier', sur: false };
      else res = { dir: geo.candidats[0], source: 'à vérifier', sur: false };
    }
  } else if (meteo !== null) res = { dir: meteo, source: 'météo', sur: false };
  else res = { dir: ancien, source: ancien === null ? '' : 'trace (approx.), à vérifier', sur: false };
  return res;
}
function getAlphaExclu(points: any[], distances: number[], maxDist: number, minDist: number, useDoppler: boolean, windDir: number | null): any {
  const seg = preparerSegments(points, useDoppler);
  let best: any = null, j0 = 1;
  const n = points.length;
  const PL = planLocal(points), PX = PL.X, PY = PL.Y, LOIN2 = (ALPHA_PROXIMITE_M * 1.03 + 0.5) ** 2;
  const vSeg = new Float64Array(n);
  for (let k = 0; k < n - 1; k++) {
    const dt = (points[k + 1].time - points[k].time) / 1000;
    vSeg[k] = dt > 0 ? ((seg.CD[k + 1] - seg.CD[k]) / dt) * KNOTS_CONVERSION : 0;
  }
  const file = new Int32Array(n); let fd = 0, ff = 0, kFin = 0;
  for (let i = 0; i < n; i++) {
    if (j0 < i + 1) j0 = i + 1;
    while (j0 < n && distances[j0] - distances[i] <= minDist) j0++;
    while (fd < ff && file[fd] < i) fd++;
    if (j0 >= n || seg.blk[j0] !== seg.blk[i]) continue;
    if (best) {
      while (kFin < n - 1 && distances[kFin] - distances[i] <= maxDist) {
        while (ff > fd && vSeg[file[ff - 1]] <= vSeg[kFin]) ff--;
        file[ff++] = kFin++;
      }
      if (fd < ff && vSeg[file[fd]] * (1 + 1e-9) + 1e-9 <= best.speed) continue;
    }
    for (let j = j0; j < n; j++) {
      if (seg.blk[j] !== seg.blk[i]) break;
      const totalD = distances[j] - distances[i];
      if (totalD > maxDist) break;
      if (totalD <= minDist) continue;
      if (points[j].time <= points[i].time) continue;
      if (best) {
        const dt = (points[j].time - points[i].time) / 1000;
        if (((seg.CD[j] - seg.CD[i]) / dt) * KNOTS_CONVERSION <= best.speed) continue;
      }
      { const dx = PX[j] - PX[i], dy = PY[j] - PY[i]; if (dx * dx + dy * dy > LOIN2) continue; }
      if (!procheDe(points, i, j, ALPHA_PROXIMITE_M, PL)) continue;
      const w = fenetre(points, seg, i, j);
      if (!couvertureOk(w, useDoppler)) continue;
      if (best && w.speed <= best.speed) continue;
      if (windDir !== null && !analyserVirage(points, i, j, windDir).empannage) continue;
      best = w;
    }
  }
  return best ? { speed: best.speed, ranges: [{ tStart: best.tStart, tEnd: best.tEnd }] } : { speed: 0, ranges: [] };
}
function statsSession(points: any[], windDir: number | null): any {
  const vide = { tot: 0, jib: 0, tack: 0, nJibe: 0, nTack: 0, vminJibe: null, vminTack: null, moyJibe: null, moyTack: null };
  const n = points.length;
  if (n < 5) return vide;
  const dts: number[] = [];
  for (let i = 1; i < n; i++) { const d = (points[i].time - points[i - 1].time) / 1000; if (d > 0 && d <= GAP_MAX_S) dts.push(d); }
  if (!dts.length) return vide;
  dts.sort((a, b) => a - b);
  const med = dts[dts.length >> 1] || 1;
  const kLisse = Math.max(1, Math.round(2 / med));
  const brg = new Float64Array(n), dst = new Float64Array(n), coupe = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const d = (points[i].time - points[i - 1].time) / 1000;
    if (!(d > 0) || d > GAP_MAX_S) { coupe[i] = 1; continue; }
    dst[i] = haversine(points[i - 1], points[i]);
    brg[i] = dst[i] > 0.01 ? bearing(points[i - 1], points[i]) : brg[i - 1];
  }
  const sc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ex = 0, ey = 0;
    for (let j = Math.max(1, i - kLisse); j <= Math.min(n - 1, i + kLisse); j++) {
      if (coupe[j]) continue;
      ex += Math.sin(brg[j] * Math.PI / 180) * dst[j];
      ey += Math.cos(brg[j] * Math.PI / 180) * dst[j];
    }
    sc[i] = (Math.atan2(ex, ey) * 180 / Math.PI + 360) % 360;
  }
  const spd = (k: number) => { const v = points[k].speed; return (v === null || v === undefined) ? 0 : v; };
  const idxAt = (k: number, dir: number) => { let acc = 0, x = k; while (dir < 0 ? x > 0 : x < n - 1) { const nx = x + dir; if (coupe[dir < 0 ? x : nx]) break; acc += haversine(points[Math.min(x, nx)], points[Math.max(x, nx)]); x = nx; if (acc >= GPSAR_D_WINDOW) break; } return x; };
  const vminEntre = (a: number, b: number) => { let v = 1e9; for (let x = a; x <= b; x++) if (!coupe[x] && spd(x) < v) v = spd(x); return v; };
  const vmaxEntre = (a: number, b: number) => { let v = 0; for (let x = a; x <= b; x++) if (!coupe[x] && spd(x) > v) v = spd(x); return v; };
  let ref: number | null = null, mid: number | null = null, tot = 0, jib = 0, tack = 0;
  const listJ: number[] = [], listT: number[] = [];
  for (let k = 0; k < n; k++) {
    if (coupe[k]) { ref = null; mid = null; continue; }
    if (spd(k) < 2) continue;
    const h = sc[k];
    if (ref === null) { ref = h; continue; }
    const d = Math.abs(angleDiff(h, ref));
    if (mid === null && d > 90) mid = h;
    if (d > 150) {
      tot++;
      const capPointe = mid == null ? h : mid;
      const est = windDir != null && Math.abs(angleDiff(capPointe, windDir)) > 90;
      if (windDir != null) {
        if (est) jib++; else tack++;
        const a0 = idxAt(k, -1), b0 = idxAt(k, 1);
        const largeur = haversine(points[a0], points[b0]);
        if (largeur <= GPSAR_MAX_WIDTH && vmaxEntre(a0, k) >= GPSAR_START_MIN) {
          const vm = vminEntre(a0, b0);
          if (vm >= GPSAR_EXAM_MIN) (est ? listJ : listT).push(vm);
        }
      }
      ref = h; mid = null;
    }
  }
  const moy = (l: number[]) => l.length ? l.reduce((a, b) => a + b, 0) / l.length : null;
  const best = (l: number[]) => l.length ? Math.max(...l) : null;
  return { tot, jib, tack, nJibe: listJ.length, nTack: listT.length, vminJibe: best(listJ), vminTack: best(listT), moyJibe: moy(listJ), moyTack: moy(listT) };
}

/** Wind of the day (Open-Meteo, free, no key): vector mean over the session hours. null if unreachable. */
export async function fetchMeteoVent(points: any[]): Promise<MeteoVent | null> {
  if (!points || points.length < 2) return null;
  const t0 = points[0].time, t1 = points[points.length - 1].time;
  let la = 0, lo = 0, k = 0;
  for (let i = 0; i < points.length; i += Math.max(1, Math.floor(points.length / 200))) { la += points[i].lat; lo += points[i].lon; k++; }
  la /= k; lo /= k;
  const jour = (t: number) => new Date(t).toISOString().slice(0, 10);
  const params = `latitude=${la.toFixed(4)}&longitude=${lo.toFixed(4)}&start_date=${jour(t0)}&end_date=${jour(t1)}&hourly=wind_direction_10m,wind_speed_10m&timezone=GMT`;
  const ageJours = (Date.now() - t1) / 86400000;
  const urls = ageJours < 60
    ? [`https://api.open-meteo.com/v1/forecast?${params}`, `https://archive-api.open-meteo.com/v1/archive?${params}`]
    : [`https://archive-api.open-meteo.com/v1/archive?${params}`, `https://api.open-meteo.com/v1/forecast?${params}`];
  for (const url of urls) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j: any = await r.json();
      const h = j && j.hourly;
      if (!h || !h.time) continue;
      const liste: [number, number][] = []; let vit = 0, nb = 0;
      for (let n = 0; n < h.time.length; n++) {
        const t = Date.parse(h.time[n] + 'Z');
        const dir = h.wind_direction_10m[n], v = h.wind_speed_10m[n];
        if (dir === null || v === null || !isFinite(t)) continue;
        if (t < t0 - 3600000 || t > t1 + 3600000) continue;
        liste.push([dir, Math.max(v, 0.1)]); vit += v; nb++;
      }
      const m = moyenneCirc(liste);
      if (m.dir !== null) return { dir: m.dir, vitesse: vit / nb };
    } catch (e) { /* offline */ }
  }
  return null;
}

// ───────────────────────── main ─────────────────────────
/** Same pipeline as the analyzer's recalculer(); `meteoDir` = wind direction from fetchMeteoVent (or null).
 *  `light` skips Alpha 250 and the manoeuvre stats (turns, jibes, tacks); every other figure is the same
 *  as in the full run - lighter on a phone. */
export function analyseSession(rawPoints: any[], meteoDir: number | null = null, light = false, doppler = true): SpeedStats | null {
  if (!rawPoints || rawPoints.length < 2) return null;
  const withSpeed = rawPoints.filter(p => p.dopplerSpeed !== null && p.dopplerSpeed !== undefined).length;
  const useDoppler = doppler && withSpeed > 0;   // doppler=false: the analyzer with "Utiliser le Doppler" unticked (positions only)
  let points: any[] = rawPoints.map(p => ({ ...p }));
  if (!useDoppler) {
    const qualite = filtrerQualiteGPS(points);
    points = nettoyerPoints(qualite.points).points;
  } else {
    const vmaxDop = FILTRE_VMAX_DEFAUT / KNOTS_CONVERSION;
    points = points.filter(p => p.dopplerSpeed === null || p.dopplerSpeed <= vmaxDop);
  }
  if (points.length < 2) return null;
  const distances: number[] = [0];
  let cum = 0;
  for (let i = 1; i < points.length; i++) { cum += haversine(points[i - 1], points[i]); distances.push(cum); }
  let totalDist = 0;
  for (let i = 1; i < rawPoints.length; i++) totalDist += haversine(rawPoints[i - 1], rawPoints[i]);
  if (useDoppler && !points.some(p => p.dopplerSpeed !== null)) return null;
  if (useDoppler) {
    for (const p of points) p.speed = p.dopplerSpeed !== null ? p.dopplerSpeed * KNOTS_CONVERSION : null;
  } else {
    for (let i = 1; i < points.length; i++) {
      const d = distances[i] - distances[i - 1], dt = (points[i].time - points[i - 1].time) / 1000;
      points[i].speed = dt > 0 ? (d / dt) * KNOTS_CONVERSION : 0;
    }
    points[0].speed = points[1] ? points[1].speed : 0;
  }
  const none: any = { speed: 0, ranges: [] };
  const vent = choisirVent(points, meteoDir);
  const windUsed = vent.dir;
  let v100m = getBestSpeedDistance(points, 100, useDoppler);
  let v500m = getBestSpeedDistance(points, 500, useDoppler);
  let v1000m = getBestSpeedDistance(points, 1000, useDoppler);
  let v1852m = getBestSpeedDistance(points, 1852, useDoppler);
  const ptsLong = pointsPourAlphas(points, useDoppler, rawPoints);
  const distLong = distancesGeo(ptsLong);
  let v5000m = getBestSpeedDistance(ptsLong, 5000, useDoppler);
  let v10000m = getBestSpeedDistance(ptsLong, 10000, useDoppler);
  let v10s = getBestSpeedWindow(points, 10, useDoppler);
  if (!useDoppler) v10s = recadrerV10sPositionnelle(v10s, v100m, points).result;
  const vmaxRes = getVmaxFiltree(points, v10s.speed, VMAX_DELTA_KTS);
  const vmax = vmaxRes.vmax;
  if (vmax > 0 && v10s.speed > vmax + 0.01) {
    const found = useDoppler ? chercherFenetreDureeSousPlafond(points, 10, vmax, true) : chercherFenetre10sPositionnelle(points, vmax, true);
    v10s = found ? { speed: found.speed, ranges: [found.range] } : { speed: vmax, ranges: v10s.ranges };
  }
  v100m = recadrerDistance(v100m, 100, vmax, points, useDoppler).result;
  if (v100m.speed >= POS_V10S_PIVOT_KTS && v10s.speed > v100m.speed + 0.01) {
    const plafond = v100m.speed;
    const found = useDoppler ? chercherFenetreDureeSousPlafond(points, 10, plafond, true) : chercherFenetre10sPositionnelle(points, plafond, true);
    v10s = found ? { speed: found.speed, ranges: [found.range] } : { speed: plafond, ranges: v10s.ranges };
  }
  v500m = recadrerDistance(v500m, 500, v100m.speed, points, useDoppler).result;
  v1000m = recadrerDistance(v1000m, 1000, v500m.speed, points, useDoppler).result;
  v1852m = recadrerDistance(v1852m, 1852, v1000m.speed, points, useDoppler).result;
  v5000m = recadrerDistance(v5000m, 5000, v1852m.speed, ptsLong, useDoppler).result;
  v10000m = recadrerDistance(v10000m, 10000, v5000m.speed, ptsLong, useDoppler).result;
  const v10sRange = (v10s.ranges && v10s.ranges.length > 0) ? v10s.ranges[0] : null;
  let top5 = getTopNAvgSpeedWindowSingleHeading(points, 10, 5, useDoppler, useDoppler ? null : v10s.speed, useDoppler ? null : v10sRange);
  if (!useDoppler && v10s.speed > 0 && top5.speed > v10s.speed + 0.01) top5 = { speed: v10s.speed, ranges: top5.ranges };
  const a250 = light ? none : getAlphaExclu(ptsLong, distLong, 250, 125, useDoppler, windUsed);
  const a500 = getAlphaExclu(ptsLong, distLong, 500, 250, useDoppler, windUsed);
  const ss = light ? { tot: 0, jib: 0, tack: 0, nJibe: 0, nTack: 0, vminJibe: null, vminTack: null, moyJibe: null, moyTack: null } : statsSession(points, windUsed);
  return {
    date: rawPoints[0].time,
    durationMs: rawPoints[rawPoints.length - 1].time - rawPoints[0].time,
    distanceM: totalDist,
    useDoppler,
    vmax, v10s: v10s.speed, top5x10s: top5.speed,
    v100m: v100m.speed, v500m: v500m.speed, v1000m: v1000m.speed, v1852m: v1852m.speed, v5000m: v5000m.speed, v10000m: v10000m.speed,
    a250: a250.speed, a500: a500.speed,
    turns: ss.tot, jibes: ss.jib, tacks: ss.tack,
    vminJibe: ss.vminJibe, vminTack: ss.vminTack, moyJibe: ss.moyJibe, moyTack: ss.moyTack, nJibe: ss.nJibe, nTack: ss.nTack,
    windDir: windUsed, windSource: vent.source, windSure: vent.sur,
    ranges: {
      vmax: vmaxRes.vmaxPoint ? [{ tStart: vmaxRes.vmaxPoint.time, tEnd: vmaxRes.vmaxPoint.time }] : [],
      v10s: v10s.ranges || [], top5x10s: top5.ranges || [], v100m: v100m.ranges || [], v500m: v500m.ranges || [],
      v1000m: v1000m.ranges || [], v1852m: v1852m.ranges || [], v5000m: v5000m.ranges || [], v10000m: v10000m.ranges || [],
      a250: a250.ranges || [], a500: a500.ranges || [],
    },
  };
}
