import React from 'react';
import { LayoutChangeEvent, Pressable, Text, View } from 'react-native';
import Icon, { IconName } from './Icon';
import { useV3Theme, v3Type } from '../../theme/v3';

// One closed row in Settings - port of desktop/qml/components/SettingsSection.qml (the Settings
// split, André 2026-10-21, "progressive disclosure"). Shows the section's title and its current
// value; a tap opens the full settings in place, under the row. Rows sit in one card on
// SettingsScreen. The screen owns which rows are open (it remembers them between visits), so
// `open` comes from the screen and the row only asks to change it, through onToggle.
//
// Screen readers: announced as a button with the title, the current value as the hint, and
// its expanded/collapsed state.
export function SettingsSection({
  title, summary, icon, open, onToggle, last = false, onLayout, children,
}: {
  title: string;
  summary?: string;
  icon?: IconName;
  open: boolean;
  onToggle: () => void;
  // Hairline under the row; off on the last row of the card.
  last?: boolean;
  onLayout?: (e: LayoutChangeEvent) => void;
  children?: React.ReactNode;
}) {
  const t = useV3Theme();
  return (
    <View onLayout={onLayout}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={summary}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 10,
          minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8,
          backgroundColor: pressed ? t.cardNested : 'transparent',
        })}
      >
        {icon && <Icon name={icon} size={20} color={t.text} />}
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: v3Type.bodyLarge, fontWeight: '700', color: t.text }}>{title}</Text>
          {!!summary && (
            <Text style={{ fontSize: v3Type.label, color: t.mutedText, marginTop: 2 }}>{summary}</Text>
          )}
        </View>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chevronRight" size={20} color={t.mutedText} />
        </View>
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          {children}
        </View>
      )}
      {!last && <View style={{ height: 1, backgroundColor: t.border, marginHorizontal: 12 }} />}
    </View>
  );
}
