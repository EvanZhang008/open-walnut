/**
 * Connection status indicator — green/yellow/red dot + text.
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useConnectionStore } from '../store/connection'

const COLORS = {
  connected: '#34C759',
  connecting: '#FF9500',
  disconnected: '#FF3B30',
} as const

export function ConnectionBadge() {
  const state = useConnectionStore((s) => s.connectionState)

  return (
    <View style={styles.container}>
      <View style={[styles.dot, { backgroundColor: COLORS[state] }]} />
      <Text style={[styles.text, { color: COLORS[state] }]}>
        {state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting...' : 'Disconnected'}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
  },
})
