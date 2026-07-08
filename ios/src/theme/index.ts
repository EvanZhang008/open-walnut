/**
 * Design system — semantic colors (light/dark), type scale, spacing grid.
 *
 * Palette follows iOS system layering (bg / secondaryBg / tertiaryBg) with a
 * warm walnut-brown tint instead of default blue. All components read colors
 * through useTheme() so dark mode is automatic.
 */

import { useColorScheme } from 'react-native'

export interface Palette {
  bg: string
  secondaryBg: string
  tertiaryBg: string
  label: string
  secondaryLabel: string
  tertiaryLabel: string
  separator: string
  tint: string
  onTint: string
  tintSoft: string
  success: string
  warning: string
  danger: string
}

export const lightPalette: Palette = {
  bg: '#FFFFFF',
  secondaryBg: '#F2F2F7',
  tertiaryBg: '#E9E9EE',
  label: '#1C1C1E',
  secondaryLabel: '#6D6D72',
  tertiaryLabel: '#AEAEB2',
  separator: '#C6C6C8',
  tint: '#8B5A2B',
  onTint: '#FFFFFF',
  tintSoft: '#F4ECE3',
  success: '#34C759',
  warning: '#FF9F0A',
  danger: '#FF3B30',
}

export const darkPalette: Palette = {
  bg: '#000000',
  secondaryBg: '#1C1C1E',
  tertiaryBg: '#2C2C2E',
  label: '#F2F2F7',
  secondaryLabel: '#98989E',
  tertiaryLabel: '#5A5A5E',
  separator: '#38383A',
  tint: '#C99659',
  onTint: '#1C1207',
  tintSoft: '#2E2418',
  success: '#30D158',
  warning: '#FFD60A',
  danger: '#FF453A',
}

export interface Theme {
  c: Palette
  isDark: boolean
}

export function useTheme(): Theme {
  const scheme = useColorScheme()
  const isDark = scheme === 'dark'
  return { c: isDark ? darkPalette : lightPalette, isDark }
}

/** Type scale — the only font sizes the app uses. */
export const type = {
  caption: 13,
  footnote: 15,
  body: 17,
  title: 22,
  largeTitle: 28,
} as const

/** 8pt spacing grid. */
export function space(n: number): number {
  return n * 8
}

export const mono = 'Menlo'
