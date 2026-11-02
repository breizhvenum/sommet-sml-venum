import React, { useEffect, useState } from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { useV3Theme } from '../theme/v3';
import { t } from '../i18n';
import Icon from './ui/Icon';
import {
  LocalGear, getAllGear, getActivityGears, recordActivityGear, removeActivityGear, clearActivityGear,
} from '../database/gearDb';
import { gearKinds, gearKindOf } from './gearKinds';

// Manual per-activity gear picker (André 2026-08-18): attribute a specific move to specific
// gear (bike, shoes, board, sail, wing, foil, fin; several at once), overriding the sport default. Writes the local usage ledger (recordActivityGear,
// keyed by the activity id, idempotent) so the gear-distance tally reflects the real choice.
// Local-first — it does not push to intervals.icu here (the app is meant to stand alone).
export function GearPicker({
  visible, activityId, distanceM, timeS, date, onClose,
}: {
  visible: boolean;
  activityId: string;
  distanceM: number;
  timeS: number;
  date: string;
  onClose: () => void;
}) {
  const theme = useV3Theme();
  const s = styles(theme);
  const [gear, setGear] = useState<LocalGear[]>([]);
  const [current, setCurrent] = useState<string[]>([]);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      setGear((await getAllGear()).filter(g => !g.parentId && !g.retired));
      setCurrent(await getActivityGears(activityId));
    })();
  }, [visible, activityId]);

  // Tap = tick / untick; the sheet stays open so several items can be ticked.
  async function toggle(g: LocalGear) {
    if (current.includes(g.id)) {
      await removeActivityGear(activityId, g.id);
      setCurrent(current.filter(x => x !== g.id));
    } else {
      await recordActivityGear(activityId, g.id, distanceM || 0, timeS || 0, date);
      setCurrent([...current, g.id]);
    }
  }
  async function clear() {
    await clearActivityGear(activityId);
    setCurrent([]);
    onClose();
  }

  const kinds = gearKinds().map(k => ({ ...k, list: gear.filter(g => gearKindOf(g.type)?.type === k.type) }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.sheet}>
          <Text style={s.title}>{t.gearPickTitle}</Text>
          <ScrollView style={{ maxHeight: 420 }}>
            {gear.length === 0 && <Text style={s.empty}>{t.gearEmpty}</Text>}
            {kinds.map(({ type, label, list }) =>
              list.length > 0 ? (
                <View key={type}>
                  <Text style={s.section}>{label}</Text>
                  {list.map(g => (
                    <TouchableOpacity key={g.id} style={s.row} onPress={() => toggle(g)}>
                      <Text style={s.rowText}>{g.name}</Text>
                      {current.includes(g.id) && <Icon name="check" size={18} color={theme.primary} />}
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null,
            )}
          </ScrollView>
          <View style={s.actions}>
            <TouchableOpacity onPress={clear}><Text style={[s.link, { color: theme.mutedText }]}>{t.gearPickClear}</Text></TouchableOpacity>
            <TouchableOpacity onPress={onClose}><Text style={s.link}>{t.close}</Text></TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = (th: ReturnType<typeof useV3Theme>) => StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' },
  sheet: { backgroundColor: th.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '85%' },
  title: { fontSize: 16, fontWeight: '800', color: th.text, marginBottom: 8 },
  section: { fontSize: 12.5, fontWeight: '800', color: th.mutedText, marginTop: 12, marginBottom: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: th.mutedText + '22' },
  rowText: { fontSize: 15, color: th.text },
  empty: { fontSize: 13, color: th.mutedText, paddingVertical: 16 },
  actions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  link: { fontSize: 14, color: th.primary, fontWeight: '700' },
});
