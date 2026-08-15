/**
 * First-run setup — welcoming screen with server URL + token (or pairing
 * link paste, or first-boot claim with a setup token).
 */

import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Clipboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { parsePairingUri } from '../src/api/config'
import { useConnectionStore } from '../src/store/connection'
import { space, type, useTheme } from '../src/theme'

export default function SetupScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const configure = useConnectionStore((s) => s.configure)
  const claim = useConnectionStore((s) => s.claim)

  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [useClaim, setUseClaim] = useState(false)
  const [busy, setBusy] = useState(false)

  const finish = () => router.replace('/(tabs)')

  const handleConnect = async () => {
    if (!url.trim()) {
      Alert.alert('Server Address', 'Enter your Walnut server URL.')
      return
    }
    setBusy(true)
    try {
      if (useClaim) {
        if (!token.trim() || !deviceName.trim()) {
          Alert.alert('Missing Info', 'Setup token and device name are both required to claim.')
          return
        }
        await claim(url.trim(), token.trim(), deviceName.trim())
      } else {
        // Token may be blank for trusted-LAN servers — /status verifies.
        await configure(url.trim(), token.trim(), deviceName.trim() || undefined)
      }
      finish()
    } catch (err) {
      Alert.alert('Connection Failed', err instanceof Error ? err.message : 'Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const handlePasteLink = async () => {
    const text = await Clipboard.getString()
    const pair = parsePairingUri(text)
    if (!pair) {
      Alert.alert('No Pairing Link', 'Copy a wn://pair link (from "walnut device add") and try again.')
      return
    }
    setToken(pair.token)
    if (pair.name) setDeviceName(pair.name)
    setUseClaim(false)
    Alert.alert('Link Pasted', 'Token filled in — enter the server address and connect.')
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: c.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: c.tintSoft }]}>
            <Ionicons name="sparkles" size={36} color={c.tint} />
          </View>
          <Text style={[styles.title, { color: c.label }]}>Walnut</Text>
          <Text style={[styles.tagline, { color: c.secondaryLabel }]}>
            Your Personal AI — tasks, notes, and conversations, everywhere.
          </Text>
        </View>

        <View style={styles.form}>
          <Text style={[styles.label, { color: c.secondaryLabel }]}>SERVER ADDRESS</Text>
          <TextInput
            style={[styles.input, { backgroundColor: c.secondaryBg, color: c.label }]}
            value={url}
            onChangeText={setUrl}
            placeholder="https://wn.example.com"
            placeholderTextColor={c.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={[styles.label, { color: c.secondaryLabel }]}>
            {useClaim ? 'SETUP TOKEN' : 'DEVICE TOKEN'}
          </Text>
          <TextInput
            style={[styles.input, { backgroundColor: c.secondaryBg, color: c.label }]}
            value={token}
            onChangeText={setToken}
            placeholder={useClaim ? 'From the server log (first boot)' : 'From "walnut device add" — blank on trusted LAN'}
            placeholderTextColor={c.tertiaryLabel}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <Text style={[styles.label, { color: c.secondaryLabel }]}>DEVICE NAME</Text>
          <TextInput
            style={[styles.input, { backgroundColor: c.secondaryBg, color: c.label }]}
            value={deviceName}
            onChangeText={setDeviceName}
            placeholder="e.g. iPhone"
            placeholderTextColor={c.tertiaryLabel}
            autoCorrect={false}
          />

          <Pressable
            onPress={handleConnect}
            disabled={busy}
            style={({ pressed }) => [
              styles.connectButton,
              { backgroundColor: c.tint },
              (pressed || busy) && { opacity: 0.7 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={c.onTint} />
            ) : (
              <Text style={[styles.connectText, { color: c.onTint }]}>Connect</Text>
            )}
          </Pressable>

          <View style={styles.secondaryRow}>
            <Pressable onPress={handlePasteLink} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.5 }}>
              <Text style={[styles.secondaryLink, { color: c.tint }]}>Paste pairing link</Text>
            </Pressable>
            <Text style={{ color: c.tertiaryLabel }}>·</Text>
            <Pressable onPress={() => setUseClaim((v) => !v)} hitSlop={8} style={({ pressed }) => pressed && { opacity: 0.5 }}>
              <Text style={[styles.secondaryLink, { color: c.tint }]}>
                {useClaim ? 'I have a device token' : 'First-time claim'}
              </Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: space(3) },
  hero: { alignItems: 'center', marginBottom: space(4) },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space(2),
  },
  title: { fontSize: type.largeTitle, fontWeight: '700' },
  tagline: {
    fontSize: type.footnote,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: space(1),
    maxWidth: 280,
  },
  form: { gap: space(1) },
  label: {
    fontSize: type.caption,
    fontWeight: '600',
    letterSpacing: 0.4,
    marginTop: space(1),
    marginLeft: 4,
  },
  input: {
    height: 46,
    borderRadius: 12,
    paddingHorizontal: 14,
    fontSize: type.body,
  },
  connectButton: {
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space(2),
  },
  connectText: { fontSize: type.body, fontWeight: '600' },
  secondaryRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space(1),
    marginTop: space(2),
  },
  secondaryLink: { fontSize: type.footnote, fontWeight: '500' },
})
