import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import RNFS from 'react-native-fs';
import { useV3Theme } from '../theme/v3';
import { readSmlPoints, analyseSession, fetchMeteoVent, SpeedStats } from '../services/SpeedAnalysis';

// Stats of a session under the map, computed from the move's SML with the same method as the user's
// analyzer (analysegpsarpro16) - speeds in knots. Wind comes from the track, then from Open-Meteo
// when reachable (the figures are recomputed with it). No wind inversion / alpha verification here.

const cache = new Map<string, SpeedStats>();

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
  const [busy, setBusy] = useState(!cache.has(smlPath));
  const [meteo, setMeteo] = useState('');

  useEffect(() => {
    let alive = true;
    if (cache.has(smlPath)) { setStats(cache.get(smlPath)!); setBusy(false); return; }
    setBusy(true);
    // let the screen draw first: the computation is synchronous
    const timer = setTimeout(async () => {
      try {
        const xml = await RNFS.readFile(smlPath, 'utf8');
        const raw = readSmlPoints(xml);
        const first = analyseSession(raw, null);
        if (!alive) return;
        if (!first) { onFailed(); return; }
        cache.set(smlPath, first);
        setStats(first); setBusy(false);
        const m = await fetchMeteoVent(raw);
        if (!alive) return;
        if (m) {
          const second = analyseSession(raw, m.dir);
          if (second && alive) {
            cache.set(smlPath, second); setStats(second);
            setMeteo(`météo ${card(m.dir)}, ${Math.round(m.vitesse / 1.852)} kts`);
          }
        } else if (alive) setMeteo('météo indisponible');
      } catch (e) {
        if (alive) onFailed();
      }
    }, 50);
    return () => { alive = false; clearTimeout(timer); };
  }, [smlPath]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  if (busy || !stats) {
    return (
      <View style={[s.wrap, { alignItems: 'center', paddingVertical: 32 }]}>
        <ActivityIndicator color={theme.text} />
        <Text style={s.note}>Calcul des statistiques…</Text>
      </View>
    );
  }
  const d = new Date(stats.date);
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return (
    <View style={s.wrap}>
      <View style={s.card}>
        <Text style={s.h}>Général · session du {date}</Text>
        <View style={s.grid}>
          <Tile label="Durée" value={hms(stats.durationMs)} />
          <Tile label="Distance" value={(stats.distanceM / 1000).toFixed(2)} unit="km" />
        </View>
      </View>
      <View style={s.card}>
        <Text style={s.h}>Vitesses (nœuds)</Text>
        <View style={s.grid}>
          <Tile label="Vmax" value={kts(stats.vmax)} big />
          <Tile label="V10s" value={kts(stats.v10s)} big />
          <Tile label="Top 5 × 10s (moy.)" value={kts(stats.top5x10s)} big />
          <Tile label="V100m" value={kts(stats.v100m)} />
          <Tile label="V500m" value={kts(stats.v500m)} />
          <Tile label="V1000m" value={kts(stats.v1000m)} />
          <Tile label="V1852m (mille)" value={kts(stats.v1852m)} />
          <Tile label="V5km" value={kts(stats.v5000m)} />
          <Tile label="V10km" value={kts(stats.v10000m)} />
        </View>
        <Text style={s.note}>{stats.useDoppler ? 'Vitesses de la montre (Doppler)' : 'Calcul par les positions GPS'}</Text>
      </View>
      <View style={s.card}>
        <Text style={s.h}>Alphas (nœuds)</Text>
        <View style={s.grid}>
          <Tile label="Alpha 250 (125–250 m)" value={kts(stats.a250)} big />
          <Tile label="Alpha 500 (250–500 m)" value={kts(stats.a500)} big />
        </View>
      </View>
      <View style={s.card}>
        <Text style={s.h}>Manœuvres</Text>
        <View style={s.grid}>
          <Tile label="Demi-tours" value={stats.turns > 0 ? String(stats.turns) : '--'}
                sub={stats.turns > 0 ? `${stats.jibes} jibe${stats.jibes > 1 ? 's' : ''} · ${stats.tacks} tack${stats.tacks > 1 ? 's' : ''}` : undefined} />
          <Tile label="Vent" value={card(stats.windDir)} />
          <Tile label="Meilleur jibe" value={kts(stats.vminJibe, 1)} unit="kts"
                sub={stats.nJibe ? `sur ${stats.nJibe} empannage(s)${stats.moyJibe != null ? ' · moy ' + stats.moyJibe.toFixed(1) : ''}` : undefined} />
          <Tile label="Meilleur virement" value={kts(stats.vminTack, 1)} unit="kts"
                sub={stats.nTack ? `sur ${stats.nTack} virement(s)${stats.moyTack != null ? ' · moy ' + stats.moyTack.toFixed(1) : ''}` : undefined} />
        </View>
        <Text style={s.note}>Vent : {stats.windSource || '--'}{meteo ? ` · ${meteo}` : ''}</Text>
      </View>
    </View>
  );
}
