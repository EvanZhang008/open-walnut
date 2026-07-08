/**
 * Friendly empty state — SF-symbol-style icon + one line of text.
 */

import { Ionicons } from '@expo/vector-icons'
import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { space, type, useTheme } from '../theme'

interface Props {
  icon: keyof typeof Ionicons.glyphMap
  title: string
  subtitle?: string
}

export function EmptyState({ icon, title, subtitle }: Props) {
  const { c } = useTheme()
  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={44} color={c.tertiaryLabel} />
      <Text style={[styles.title, { color: c.label }]}>{title}</Text>
      {subtitle && <Text style={[styles.subtitle, { color: c.secondaryLabel }]}>{subtitle}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: space(1),
    padding: space(4),
  },
  title: { fontSize: type.body, fontWeight: '600', marginTop: space(1) },
  subtitle: { fontSize: type.footnote, textAlign: 'center', lineHeight: 21 },
})
