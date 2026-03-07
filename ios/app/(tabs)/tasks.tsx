/**
 * Tasks screen — placeholder for post-MVP.
 * Shows a simple message directing users to use web UI for task management.
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function TasksScreen() {
  return (
    <View style={styles.container}>
      <Ionicons name="checkbox-outline" size={64} color="#C7C7CC" />
      <Text style={styles.title}>Tasks</Text>
      <Text style={styles.subtitle}>
        Task list coming soon.{'\n'}
        Use the web UI for task management.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  subtitle: {
    fontSize: 15,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 22,
  },
})
