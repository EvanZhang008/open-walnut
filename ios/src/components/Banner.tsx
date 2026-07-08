/**
 * Non-blocking inline banner — offline notice, conflict notice, errors.
 */

import { Ionicons } from '@expo/vector-icons'
import React from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { type, useTheme } from '../theme'

interface Props {
  kind: 'info' | 'warning' | 'error'
  text: string
  onDismiss?: () => void
}

export function Banner({ kind, text, onDismiss }: Props) {
  const { c, isDark } = useTheme()
  const tone = kind === 'error' ? c.danger : kind === 'warning' ? c.warning : c.tint
  const bg = isDark ? c.tertiaryBg : c.secondaryBg

  return (
    <Pressable
      style={[styles.banner, { backgroundColor: bg }]}
      onPress={onDismiss}
      disabled={!onDismiss}
      accessibilityRole={onDismiss ? 'button' : 'text'}
    >
      <Ionicons
        name={kind === 'error' ? 'alert-circle' : kind === 'warning' ? 'cloud-offline' : 'information-circle'}
        size={16}
        color={tone}
      />
      <Text style={[styles.text, { color: c.secondaryLabel }]} numberOfLines={2}>
        {text}
      </Text>
      {onDismiss && <Ionicons name="close" size={14} color={c.tertiaryLabel} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  text: { flex: 1, fontSize: type.caption, lineHeight: 17 },
})
