import React, { useEffect, useRef, useState } from 'react';
import { WebView } from 'react-native-webview';
import Svg, { Path, Circle } from 'react-native-svg';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import RNFS from 'react-native-fs';
import { useV3Theme } from '../theme/v3';
import { readSmlPoints, analyseSession, fetchMeteoVent, SpeedStats } from '../services/SpeedAnalysis';
import { shareFile } from '../native/AmbitUsbModule';
import { captureTrack, buildCaptureHtml, smlHeartRate } from '../services/CaptureImage';

// Stats of a session under the map, computed from the move's SML with the same method as the user's
// analyzer (analysegpsarpro16) - speeds in knots. Wind comes from the track, then from Open-Meteo
// when reachable (the figures are recomputed with it). No wind inversion / alpha verification here.

const cache = new Map<string, SpeedStats>();
const VMAX_DEFAULT = 40.0;   // kts - the Vmax ceiling, always shown as 0.0
const keyOf = (path: string, vmaxOn: boolean, vmaxKts: number) =>
  path + (!vmaxOn ? '|novmax' : (vmaxKts === VMAX_DEFAULT ? '' : `|v${vmaxKts.toFixed(1)}`));

// The result is also kept on the phone (reading the SML takes ~5 s, so it is done once per activity).
// Bump the version when the calculation changes so old figures are not shown.
const STORE_PREFIX = 'speedstats_v4:';
function store(): any { try { return require('@react-native-async-storage/async-storage').default; } catch (e) { return null; } }
async function loadStored(path: string): Promise<SpeedStats | null> {
  try { const st = store(); if (!st) return null; const v = await st.getItem(STORE_PREFIX + path); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function saveStored(path: string, r: SpeedStats): Promise<void> {
  try { const st = store(); if (st) await st.setItem(STORE_PREFIX + path, JSON.stringify(r)); } catch (e) { /* not kept: recomputed next time */ }
}

const kts = (v: number | null | undefined, d = 2) => (v !== null && v !== undefined && v > 0 ? v.toFixed(d) : '--');
const hms = (ms: number) => {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const card = (deg: number | null) => deg === null ? '--' : `${CARD[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]} (${Math.round(deg)}°)`;

export default function SpeedStatsPanel({ smlPath, onFailed, title }: { smlPath: string; onFailed: () => void; title?: string }) {
  const theme = useV3Theme();
  // The acceleration filter (1.8) is always on. The Vmax filter ("filter an aberrant Vmax", ceiling in kts,
  // format 0.0, default 40.0) is ALWAYS on when an activity opens; the box / value only change the current
  // view (not remembered), so the default result is the filtered one.
  const [vmaxOn, setVmaxOn] = useState(true);
  const [vmaxKts, setVmaxKts] = useState(VMAX_DEFAULT);          // applied value
  const [vmaxTxt, setVmaxTxt] = useState(VMAX_DEFAULT.toFixed(1)); // what is being typed
  const k = keyOf(smlPath, vmaxOn, vmaxKts);
  const [stats, setStats] = useState<SpeedStats | null>(cache.get(keyOf(smlPath, true, VMAX_DEFAULT)) ?? null);
  const [busy, setBusy] = useState(false);
  const [meteo, setMeteo] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function toggleFilters() { setVmaxOn(v => !v); }
  function applyVmaxTxt() {
    const n = parseFloat(vmaxTxt.replace(',', '.'));
    const v = isFinite(n) ? Math.min(100, Math.max(20, n)) : VMAX_DEFAULT;
    setVmaxKts(Math.round(v * 10) / 10); setVmaxTxt((Math.round(v * 10) / 10).toFixed(1));
  }
  // A new activity (new smlPath) always starts with the Vmax filter on, at 40.0.
  useEffect(() => { setVmaxOn(true); setVmaxKts(VMAX_DEFAULT); setVmaxTxt(VMAX_DEFAULT.toFixed(1)); }, [smlPath]);
  useEffect(() => {
    setStats(cache.get(k) ?? null); setMeteo(''); setBusy(false);
    if (cache.has(k)) return;
    loadStored(k).then(r => {
      if (r && alive.current && !cache.has(k)) { cache.set(k, r); setStats(r); setMeteo('résultat enregistré'); }
    });
  }, [smlPath, vmaxOn, vmaxKts]);

  // Capture image of the session (no heart rate): built in a hidden WebView, then shared as a PNG.
  const [capHtml, setCapHtml] = useState<string | null>(null);
  const [capBusy, setCapBusy] = useState(false);
  async function startCapture() {
    if (capBusy || !stats) return;
    setCapBusy(true);
    try {
      const raw = readSmlPoints(await RNFS.readFile(smlPath, 'utf8'));
      // full figures (Alpha 250 included), same settings as the view
      const full = analyseSession(raw, stats.windDir, false, false, vmaxOn ? vmaxKts : null) || stats;
      const html = buildCaptureHtml(full, captureTrack(raw), title || '', 'Ambit rom1rv');
      if (alive.current) setCapHtml(html);
      setTimeout(() => { if (alive.current) { setCapHtml(null); setCapBusy(false); } }, 30000);   // safety net
    } catch (e) { if (alive.current) { setCapBusy(false); setCapHtml(null); } }
  }
  async function onCaptureMsg(msg: string) {
    setCapHtml(null);
    try {
      if (msg.startsWith('PNG:')) {
        const d = new Date(stats ? stats.date : Date.now());
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const path = `${RNFS.CachesDirectoryPath}/rom1rv_speed_${stamp}.png`;
        await RNFS.writeFile(path, msg.slice(4), 'base64');
        await shareFile(path, 'image/png');
      }
    } catch (e) { /* share cancelled or failed: nothing else to do */ }
    if (alive.current) setCapBusy(false);
  }

  // Nothing is computed when the activity opens (it is slow on a phone): the button starts it.
  function compute() {
    if (busy) return;
    setBusy(true);
    // let "please wait..." draw first: the computation below is synchronous
    setTimeout(async () => {
      try {
        const xml = await RNFS.readFile(smlPath, 'utf8');
        const raw = readSmlPoints(xml);
        const hr = smlHeartRate(xml);
        // wind of the day first (5 s at most), so the alpha is computed only once
        const m = await Promise.race([fetchMeteoVent(raw), new Promise<null>(r => setTimeout(() => r(null), 5000))]);
        if (!alive.current) return;
        const res = analyseSession(raw, m ? m.dir : null, true, false, vmaxOn ? vmaxKts : null);   // Doppler unticked: positions only
        if (!res) { setBusy(false); onFailed(); return; }
        res.hrAvg = hr ? hr.avg : null; res.hrMax = hr ? hr.max : null;
        cache.set(k, res);
        saveStored(k, res);
        setStats(res); setBusy(false);
        setMeteo(m ? `météo ${card(m.dir)}, ${Math.round(m.vitesse / 1.852)} kts` : 'météo indisponible');
      } catch (e) {
        if (alive.current) { setBusy(false); onFailed(); }
      }
    }, 80);
  }

  const s = StyleSheet.create({
    wrap: { padding: 12 },
    card: { backgroundColor: theme.card, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, marginBottom: 12 },
    h: { color: theme.mutedText, fontSize: 12, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 8 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
    tile: { width: '50%', padding: 4 },
    tileIn: { backgroundColor: theme.cardNested, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10 },
    label: { color: theme.mutedText, fontSize: 12 },
    value: { color: theme.text, fontSize: 22, fontWeight: '700' },
    big: { color: theme.primary },
    sub: { color: theme.mutedText, fontSize: 11, marginTop: 1 },
    note: { color: theme.mutedText, fontSize: 12, marginTop: 6 },
  });
  const Tile = ({ label, value, unit, big, sub }: { label: string; value: string; unit?: string; big?: boolean; sub?: string }) => (
    <View style={s.tile}><View style={s.tileIn}>
      <Text style={s.label}>{label}</Text>
      <Text style={[s.value, big && s.big]}>{value}{unit && value !== '--' ? <Text style={s.label}> {unit}</Text> : null}</Text>
      {!!sub && <Text style={s.sub}>{sub}</Text>}
    </View></View>
  );

  const FilterBox = (
    <View style={{ marginTop: 12, paddingHorizontal: 4 }}>
      <TouchableOpacity onPress={toggleFilters} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: theme.primary, alignItems: 'center', justifyContent: 'center', backgroundColor: vmaxOn ? theme.primary : 'transparent' }}>
          {vmaxOn ? <Text style={{ color: '#fff', fontWeight: '800', lineHeight: 18 }}>✓</Text> : null}
        </View>
        <Text style={{ color: theme.text, fontSize: 13, marginLeft: 10, flexShrink: 1 }}>Filtrer une Vmax aberrante</Text>
      </TouchableOpacity>
      {/* Last line: "Plafond à [40.0] kts", all on one row, lined up under the label (22 box + 10 gap) */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, marginLeft: 32 }}>
        <Text style={{ color: theme.text, fontSize: 13 }}>avec un plafond à</Text>
        <TextInput
          value={vmaxTxt} onChangeText={setVmaxTxt} onBlur={applyVmaxTxt} onSubmitEditing={applyVmaxTxt}
          editable={vmaxOn} keyboardType="decimal-pad" selectTextOnFocus maxLength={5}
          style={{ marginLeft: 8, width: 62, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.border,
            color: vmaxOn ? theme.text : theme.mutedText, textAlign: 'center', fontSize: 14, opacity: vmaxOn ? 1 : 0.5 }} />
        <Text style={{ color: theme.text, fontSize: 13, marginLeft: 6 }}>kts</Text>
      </View>
    </View>
  );

  if (!stats) {
    return (
      <View style={[s.wrap, { alignItems: 'center', paddingVertical: 24 }]}>
        <TouchableOpacity onPress={compute} disabled={busy} activeOpacity={0.8}
          style={{ backgroundColor: theme.primary, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, opacity: busy ? 0.7 : 1 }}>
          {busy
            ? <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <ActivityIndicator color="#fff" />
                <Text style={{ color: '#fff', fontWeight: '700', marginLeft: 10 }}>(please wait...)</Text>
              </View>
            : <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center' }}>Calculer les statistiques by rom1rv Speed</Text>}
        </TouchableOpacity>
        {FilterBox}
      </View>
    );
  }
  const d = new Date(stats.date);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return (
    <View style={s.wrap}>
      <View style={s.card}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <Text style={s.h}>Speed · {date}</Text>
          <TouchableOpacity onPress={startCapture} disabled={capBusy} hitSlop={{ top: 10, bottom: 10, left: 12, right: 6 }} activeOpacity={0.6} style={{ marginTop: -2, opacity: capBusy ? 0.4 : 0.85 }}>
            {capBusy
              ? <ActivityIndicator size="small" color={theme.mutedText} />
              : <Svg width={20} height={20} viewBox="0 0 24 24">
                  <Path d="M4 8h3l1.6-2.2h6.8L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" fill="none" stroke={theme.mutedText} strokeWidth={1.8} strokeLinejoin="round" />
                  <Circle cx={12} cy={13.2} r={3.4} fill="none" stroke={theme.mutedText} strokeWidth={1.8} />
                </Svg>}
          </TouchableOpacity>
        </View>
        <View style={s.grid}>
          <Tile label="Distance totale" value={(stats.distanceM / 1000).toFixed(2)} unit="km" />
          <Tile label="Vmax" value={kts(stats.vmax)} unit="kts" big />
          <Tile label="V10s" value={kts(stats.v10s)} unit="kts" big />
          <Tile label="Top 5 × 10s (moy.)" value={kts(stats.top5x10s)} unit="kts" big />
          <Tile label="V100m" value={kts(stats.v100m)} unit="kts" />
          <Tile label="V500m" value={kts(stats.v500m)} unit="kts" />
          <Tile label="V1000m" value={kts(stats.v1000m)} unit="kts" />
          <Tile label="V1852m (1 mille)" value={kts(stats.v1852m)} unit="kts" />
          <Tile label="V10km" value={kts(stats.v10000m)} unit="kts" />
          <Tile label="Alpha 500" value={kts(stats.a500)} unit="kts" big />
          {stats.hrAvg ? <Tile label="♥ FC moyenne" value={String(stats.hrAvg)} unit="bpm" /> : null}
          {stats.hrMax ? <Tile label="♥ FC max" value={String(stats.hrMax)} unit="bpm" /> : null}
        </View>
        <Text style={s.note}>Vent : {stats.windSource || '--'}{meteo ? ` · ${meteo}` : ''}{!vmaxOn ? ' · Vmax non filtrée' : (vmaxKts !== VMAX_DEFAULT ? ` · plafond ${vmaxKts.toFixed(1)} kts` : '')}</Text>
        {FilterBox}
      </View>
      {capHtml ? (
        <View pointerEvents="none" style={{ position: 'absolute', width: 4, height: 4, opacity: 0, overflow: 'hidden' }}>
          <WebView originWhitelist={['*']} source={{ html: capHtml, baseUrl: 'https://localhost/' }} javaScriptEnabled
            onMessage={e => onCaptureMsg(e.nativeEvent.data)} onError={() => { setCapHtml(null); setCapBusy(false); }}
            style={{ width: 4, height: 4 }} />
        </View>
      ) : null}
    </View>
  );
}
