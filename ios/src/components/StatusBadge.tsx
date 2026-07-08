/**
 * Server mode badge — LIVE (green dot) / REPLICA (amber dot) / offline (red).
 */

import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useConnectionStore } from '../store/connection'
import { type, useTheme } from '../theme'

export function StatusBadge({ detailed = false }: { detailed?: boolean }) {
  const { c } = useTheme()
  const status = useConnectionStore((s) => s.status)
  const online = useConnectionStore((s) => s.online)

  const color = !online ? c.danger : status?.mode === 'LIVE' ? c.success : status ? c.warning : c.tertiaryLabel
  const label = !online ? 'Offline' : status?.mode === 'LIVE' ? 'Live' : status ? 'Replica' : '—'
  const subtitle = online && status?.mode === 'REPLICA' ? 'Mac offline — replica mode' : null

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={[styles.label, { color: c.secondaryLabel }]}>{label}</Text>
      </View>
      {detailed && subtitle && (
        <Text style={[styles.subtitle, { color: c.tertiaryLabel }]}>{subtitle}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'flex-end' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  label: { fontSize: type.caption, fontWeight: '500' },
  subtitle: { fontSize: 11, marginTop: 1 },
})
