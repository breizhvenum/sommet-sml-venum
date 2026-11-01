// v3.0 design tokens - real, 2026-08-09 ("implement the UI we have been ironing for desktop
// on the android and call it v3.0"). Deliberately a NEW, separate set of tokens rather than
// changing tokens.ts's existing lightColors/darkColors values in place: only 5 files read
// useTheme() today, but primitives.tsx (Section/Button/Chip/etc, used by every screen) reads
// it too, so changing those values in place would instantly re-skin the whole app the moment
// this file was touched - not what "one screen first as proof of concept" (2026-08-09 rollout
// decision) means. Screens migrate to useV3Theme()/Card/NavShell one at a time; tokens.ts
// stays exactly as it is for whichever screens haven't moved onto this yet.
//
// spacing/radius/type scale still copied by hand from desktop/qml/Theme.qml, same reasoning
// as before: one shared layout/type language across both apps. As of 2026-08-15 the COLOR
// palette is fully mutualized with desktop too: dark mode was already the shared slate grey
// (the 2026-08-09 "change to a nicer grey" pass), and light mode is now back on desktop's
// teal (see v3Light below) after that pass had left the two apps mismatched in light mode.
// Every token here now equals its Theme.qml counterpart exactly, so the two apps render the
// same colors in both themes.

import { useThemeMode } from './ThemeModeContext';

export interface V3Colors {
  background: string;
  // 2026-08-25 tune-up (mutualised from desktop/qml/Theme.qml the same session): the surface
  // stepping the light theme was missing. `surface` is the content region a screen sits on,
  // `cardNested` is for things inside a card (list rows, grouped settings), `border`/
  // `borderStrong` are the hairline between levels. `hard` is the orange training-load
  // semantic between warning-amber and error-red.
  surface: string;
  card: string;
  cardNested: string;
  border: string;
  borderStrong: string;
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  hard: string;
  error: string;
  text: string;
  mutedText: string;
}

// 2026-08-25 "UI tune-up" (André): calmer, lower-chroma colour + real surface hierarchy,
// agreed off an editable design canvas and applied identically to desktop (Theme.qml) and
// the Ember PWA (ember/app.css) so all three apps stay one coherent theme. The teal identity
// (#167E6A) and the semantic ramp were pulled toward quieter tones; green is still the
// identity, just less flashy.
export const v3Light: V3Colors = {
  // rom1rv palette (2026-11): cool neutral greys + one confident red accent.
  background: '#ECEDEF',
  surface:    '#F3F4F5',
  card:       '#FFFFFF',
  cardNested: '#EFF0F2',
  border:     '#DADCE0',
  borderStrong: '#C3C6CC',
  primary:    '#A3212D',
  secondary:  '#5E626B',
  accent:     '#C2343F',
  success:    '#3E7D52',
  warning:    '#9A7A22',
  hard:       '#B5652F',
  error:      '#A61E2A',
  text:       '#191B1F',
  mutedText:  '#5E626B',
};

export const v3Dark: V3Colors = {
  background: '#0E0F11',
  surface:    '#16181B',
  card:       '#1C1E22',
  cardNested: '#25282D',
  border:     '#2D3036',
  borderStrong: '#3C4048',
  primary:    '#CF3E46',
  secondary:  '#B3B8C0',
  accent:     '#E5595F',
  success:    '#5C9E72',
  warning:    '#CB9A45',
  hard:       '#CE8258',
  error:      '#F0757B',
  text:       '#EDEEF0',
  mutedText:  '#B6BAC2',
};

// Theme.qml's spacingSmall/Medium/Large and radiusSmall/radiusCard, unchanged.
export const v3Spacing = { small: 8, medium: 16, large: 24 };
export const v3Radius = { small: 8, card: 16 };

// Theme.qml's real type scale (10-24px named tokens, its own 2026-08-09 addition).
export const v3Type = {
  tiny: 10,
  caption: 11,
  label: 12,
  body: 13,
  bodyLarge: 14,
  subtitle: 15,
  heading: 16,
  title: 18,
  largeTitle: 20,
  display: 24,
};

export function useV3Theme(): V3Colors {
  const { isDark } = useThemeMode();
  return isDark ? v3Dark : v3Light;
}
