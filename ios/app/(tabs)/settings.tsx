/**
 * Settings screen — connection management, push notification toggle.
 */

import React, { useState, useEffect } from 'react'
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Switch,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useConnectionStore } from '../../src/store/connection'
import { clearAll } from '../../src/utils/secure-store'
import { ConnectionBadge } from '../../src/components/ConnectionBadge'

export default function SettingsScreen() {
  const router = useRouter()
  const serverUrl = useConnectionStore((s) => s.serverUrl)
  const connectionState = useConnectionStore((s) => s.connectionState)
  const connect = useConnectionStore((s) => s.connect)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const [pushEnabled, setPushEnabled] = useState(true)

  const handleReconnect = () => {
    disconnect()
    setTimeout(() => connect(), 500)
  }

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect',
      'This will remove your saved credentials. You will need to reconfigure.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            disconnect()
            await clearAll()
            useConnectionStore.setState({ isConfigured: false, serverUrl: '', apiKey: '' })
            router.replace('/setup')
          },
        },
      ]
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Connection status */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Connection</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Status</Text>
            <ConnectionBadge />
          </View>
          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={styles.label}>Server</Text>
            <Text style={styles.value} numberOfLines={1}>{serverUrl || 'Not configured'}</Text>
          </View>
        </View>
      </View>

      {/* Push notifications */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>Push Notifications</Text>
            <Switch
              value={pushEnabled}
              onValueChange={setPushEnabled}
              trackColor={{ false: '#E5E5EA', true: '#34C759' }}
            />
          </View>
        </View>
        <Text style={styles.hint}>
          Receive push notifications when sessions complete, tasks need attention, or scheduled jobs run.
        </Text>
      </View>

      {/* Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Actions</Text>
        <TouchableOpacity style={styles.actionButton} onPress={handleReconnect}>
          <Ionicons name="refresh" size={20} color="#007AFF" />
          <Text style={styles.actionText}>Reconnect</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={handleDisconnect}>
          <Ionicons name="log-out" size={20} color="#FF3B30" />
          <Text style={[styles.actionText, styles.dangerText]}>Disconnect & Reset</Text>
        </TouchableOpacity>
      </View>

      {/* Version */}
      <Text style={styles.version}>Walnut iOS v0.1.0</Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  content: {
    padding: 16,
    gap: 24,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    paddingHorizontal: 16,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#E5E5EA',
    marginLeft: 16,
  },
  label: {
    fontSize: 16,
    color: '#1C1C1E',
  },
  value: {
    fontSize: 14,
    color: '#8E8E93',
    maxWidth: 200,
    textAlign: 'right',
  },
  hint: {
    fontSize: 13,
    color: '#8E8E93',
    paddingHorizontal: 16,
    lineHeight: 18,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
  },
  actionText: {
    fontSize: 16,
    color: '#007AFF',
    fontWeight: '500',
  },
  dangerButton: {},
  dangerText: {
    color: '#FF3B30',
  },
  version: {
    fontSize: 13,
    color: '#C7C7CC',
    textAlign: 'center',
    marginTop: 8,
  },
})
