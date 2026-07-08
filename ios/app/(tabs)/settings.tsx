/**
 * Settings — server connection details, pairing-link paste, connection test,
 * and reset. Token lives in the Keychain and is shown masked.
 */

import { Ionicons } from '@expo/vector-icons'
import React, { useState } from 'react'
// RN core Clipboard is deprecated but read-only paste is all we need — avoids
// adding expo-clipboard as a dependency.
import { Alert, Clipboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { parsePairingUri } from '../../src/api/config'
import { StatusBadge } from '../../src/components/StatusBadge'
import { useChatStore } from '../../src/store/chat'
import { useConnectionStore } from '../../src/store/connection'
import { space, type, useTheme } from '../../src/theme'

export default function SettingsScreen() {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  const serverUrl = useConnectionStore((s) => s.serverUrl)
  const deviceName = useConnectionStore((s) => s.deviceName)
  const status = useConnectionStore((s) => s.status)
  const refreshStatus = useConnectionStore((s) => s.refreshStatus)
  const configure = useConnectionStore((s) => s.configure)
  const reset = useConnectionStore((s) => s.reset)
  const closeStream = useChatStore((s) => s.closeStream)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await refreshStatus()
      const st = useConnectionStore.getState().status
      const online = useConnectionStore.getState().online
      setTestResult(
        online && st
          ? `Connected — ${st.mode} · v${st.version}`
          : 'Could not reach the server'
      )
    } finally {
      setTesting(false)
    }
  }

  const handlePastePairing = async () => {
    const text = await Clipboard.getString()
    const pair = parsePairingUri(text)
    if (!pair) {
      Alert.alert('No Pairing Link', 'Copy a wn://pair link first, then try again.')
      return
    }
    if (!serverUrl) {
      Alert.alert('Server URL Missing', 'Set up the server first, then pair.')
      return
    }
    try {
      await configure(serverUrl, pair.token, pair.name)
      Alert.alert('Paired', pair.name ? `Connected as "${pair.name}".` : 'Device token updated.')
    } catch (err) {
      Alert.alert('Pairing Failed', err instanceof Error ? err.message : 'Could not verify the token.')
    }
  }

  const handleReset = () => {
    Alert.alert('Sign Out', 'Removes the server URL and device token from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign Out',
        style: 'destructive',
        onPress: () => {
          closeStream()
          void reset()
        },
      },
    ])
  }

  const Card = ({ children }: { children: React.ReactNode }) => (
    <View style={[styles.card, { backgroundColor: c.bg, borderColor: c.separator }]}>{children}</View>
  )

  const Row = ({ label, value, last }: { label: string; value: React.ReactNode; last?: boolean }) => (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.separator }]}>
      <Text style={[styles.rowLabel, { color: c.label }]}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.rowValue, { color: c.secondaryLabel }]} numberOfLines={1}>
          {value}
        </Text>
      ) : (
        value
      )}
    </View>
  )

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.secondaryBg }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + space(1) }]}
    >
      <Text style={[styles.largeTitle, { color: c.label }]}>Settings</Text>
      <Text style={[styles.sectionTitle, { color: c.secondaryLabel }]}>SERVER</Text>
      <Card>
        <Row label="Address" value={serverUrl || 'Not configured'} />
        <Row label="Device" value={deviceName || '—'} />
        <Row label="Token" value="••••••••••••" />
        <Row label="Status" value={<StatusBadge detailed />} last />
      </Card>

      <Pressable
        onPress={handleTest}
        disabled={testing}
        style={({ pressed }) => [styles.action, { backgroundColor: c.bg, borderColor: c.separator }, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="pulse-outline" size={19} color={c.tint} />
        <Text style={[styles.actionText, { color: c.tint }]}>{testing ? 'Testing…' : 'Test Connection'}</Text>
      </Pressable>
      {testResult && (
        <Text style={[styles.testResult, { color: c.secondaryLabel }]}>{testResult}</Text>
      )}

      <Text style={[styles.sectionTitle, { color: c.secondaryLabel }]}>PAIRING</Text>
      <Pressable
        onPress={handlePastePairing}
        style={({ pressed }) => [styles.action, { backgroundColor: c.bg, borderColor: c.separator }, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="link-outline" size={19} color={c.tint} />
        <Text style={[styles.actionText, { color: c.tint }]}>Paste Pairing Link</Text>
      </Pressable>
      <Text style={[styles.hint, { color: c.tertiaryLabel }]}>
        Run "walnut device add" on your Mac, copy the wn://pair link, then tap above.
      </Text>

      <Text style={[styles.sectionTitle, { color: c.secondaryLabel }]}>ACCOUNT</Text>
      <Pressable
        onPress={handleReset}
        style={({ pressed }) => [styles.action, { backgroundColor: c.bg, borderColor: c.separator }, pressed && { opacity: 0.6 }]}
      >
        <Ionicons name="log-out-outline" size={19} color={c.danger} />
        <Text style={[styles.actionText, { color: c.danger }]}>Sign Out</Text>
      </Pressable>

      <Text style={[styles.about, { color: c.tertiaryLabel }]}>
        Walnut{status ? ` · server v${status.version}` : ''}
        {'\n'}Your personal AI butler
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: space(2), paddingBottom: space(5) },
  largeTitle: { fontSize: type.largeTitle, fontWeight: '700', marginLeft: space(0.5), marginBottom: space(0.5) },
  sectionTitle: {
    fontSize: type.caption,
    fontWeight: '600',
    letterSpacing: 0.4,
    marginTop: space(3),
    marginBottom: space(1),
    marginLeft: space(2),
  },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space(2),
    paddingVertical: 13,
    gap: space(1),
  },
  rowLabel: { fontSize: type.body },
  rowValue: { fontSize: type.footnote, flexShrink: 1 },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space(2),
    paddingVertical: 13,
    marginTop: space(1),
  },
  actionText: { fontSize: type.body, fontWeight: '500' },
  testResult: { fontSize: type.caption, marginTop: space(1), marginLeft: space(2) },
  hint: {
    fontSize: type.caption,
    lineHeight: 17,
    marginTop: space(1),
    marginHorizontal: space(2),
  },
  about: {
    fontSize: type.caption,
    textAlign: 'center',
    lineHeight: 18,
    marginTop: space(5),
  },
})
