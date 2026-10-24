import React, { useState } from 'react';
import { View, Text, TextInput, Keyboard } from 'react-native';
import { useV3Theme } from '../theme/v3';
import { t } from '../i18n';
import { parseCompiledText, CompiledApp } from '../services/IntervalsService';

// The compiler site shows its result as text in its lower box and has no download button, so on
// a phone that text could only reach Sommet as a file saved with some other app (André,
// 2026-10-24: "paste box"). Pasting it here takes the same result straight in. A good paste is
// handed over and the box empties; anything else stays, with a line saying what to copy.
export function CompiledPasteBox({ fallbackName, onCompiled }: {
  fallbackName: string;
  onCompiled: (compiled: CompiledApp) => void;
}) {
  const theme = useV3Theme();
  const [text, setText] = useState('');

  function onChange(value: string) {
    const compiled = parseCompiledText(value, fallbackName);
    if (compiled) {
      setText('');
      Keyboard.dismiss();
      onCompiled(compiled);
    } else {
      setText(value);
    }
  }

  return (
    <View style={{ marginTop: 10 }}>
      <Text style={{ fontSize: 12, color: theme.mutedText, marginBottom: 4 }}>{t.compiledPasteLabel}</Text>
      <TextInput
        style={{
          backgroundColor: theme.background, borderRadius: 8, borderWidth: 1, borderColor: theme.mutedText + '33',
          paddingHorizontal: 12, paddingVertical: 9, color: theme.text, fontFamily: 'monospace', fontSize: 11,
          // Fixed: Android grows a multiline box to fit a paste and never shrinks it back.
          height: 64, textAlignVertical: 'top',
        }}
        value={text}
        onChangeText={onChange}
        multiline
        autoCorrect={false}
        autoCapitalize="none"
      />
      {text.trim().length > 0 && (
        <Text style={{ fontSize: 12.5, color: theme.error, marginTop: 6, lineHeight: 18 }}>{t.compiledPasteBad}</Text>
      )}
    </View>
  );
}
