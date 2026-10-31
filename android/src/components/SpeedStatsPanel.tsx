import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import RNFS from 'react-native-fs';
import { useV3Theme } from '../theme/v3';
import { readSmlPoints, analyseSession, fetchMeteoVent, SpeedStats } from '../services/SpeedAnalysis';

// Stats of a session under the map, computed from the move's SML with the same method as the user's
// analyzer (analysegpsarpro16) - speeds in knots. Wind comes from the track, then from Open-Meteo
// when reachable (the figures are recomputed with it). No wind inversion / alpha verification here.

const cache = new Map<string, SpeedStats>();

// The result is also kept on the phone (reading the SML takes ~5 s, so it is done once per activity).
// Bump the version when the calculation changes so old figures are not shown.
const STORE_PREFIX = 'speedstats_v2:';
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

export default function SpeedStatsPanel({ smlPath, onFailed }: { smlPath: string; onFailed: () => void }) {
  const theme = useV3Theme();
  const [stats, setStats] = useState<SpeedStats | null>(cache.get(smlPath) ?? null);
  const [busy, setBusy] = useState(false);
  const [meteo, setMeteo] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setStats(cache.get(smlPath) ?? null); setMeteo(''); setBusy(false);
    if (cache.has(smlPath)) return;
    loadStored(smlPath).then(r => {
      if (r && alive.current && !cache.has(smlPath)) { cache.set(smlPath, r); setStats(r); setMeteo('résultat enregistré'); }
    });
  }, [smlPath]);

  // Nothing is computed when the activity opens (it is slow on a phone): the button starts it.
  function compute() {
    if (busy) return;
    setBusy(true);
    // let "please wait..." draw first: the computation below is synchronous
    setTimeout(async () => {
      try {
        const xml = await RNFS.readFile(smlPath, 'utf8');
        const raw = readSmlPoints(xml);
        // wind of the day first (5 s at most), so the alpha is computed only once
        const m = await Promise.race([fetchMeteoVent(raw), new Promise<null>(r => setTimeout(() => r(null), 5000))]);
        if (!alive.current) return;
        const res = analyseSession(raw, m ? m.dir : null, true, false);   // Doppler unticked: positions only
        if (!res) { setBusy(false); onFailed(); return; }
        cache.set(smlPath, res);
        saveStored(smlPath, res);
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
            : <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center' }}>Calculer les statistiques vitesses by Venum</Text>}
        </TouchableOpacity>
      </View>
    );
  }
  const d = new Date(stats.date);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return (
    <View style={s.wrap}>
      <View style={s.card}>
        <Text style={s.h}>Statistiques vitesses by Venum · {date}</Text>
        <View style={s.grid}>
          <Tile label="Distance totale" value={(stats.distanceM / 1000).toFixed(2)} unit="km" />
          <Tile label="Vmax" value={kts(stats.vmax)} unit="kts" big />
          <Tile label="V10s" value={kts(stats.v10s)} unit="kts" big />
          <Tile label="Top 5 × 10s (moy.)" value={kts(stats.top5x10s)} unit="kts" big />
          <Tile label="V100m" value={kts(stats.v100m)} unit="kts" />
          <Tile label="V500m" value={kts(stats.v500m)} unit="kts" />
          <Tile label="V10km" value={kts(stats.v10000m)} unit="kts" />
          <Tile label="Alpha 500" value={kts(stats.a500)} unit="kts" big />
        </View>
        <Text style={s.note}>Vent : {stats.windSource || '--'}{meteo ? ` · ${meteo}` : ''}</Text>
      </View>
    </View>
  );
}
