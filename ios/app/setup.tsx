/**
 * Setup screen — first-time configuration of server URL and API key.
 */

import React, { useState } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
  SafeAreaView,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { testConnection } from '../src/api/client'
import { useConnectionStore } from '../src/store/connection'

export default function SetupScreen() {
  const router = useRouter()
  const configure = useConnectionStore((s) => s.configure)
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [tested, setTested] = useState(false)

  const handleTest = async () => {
    if (!url.trim()) {
      Alert.alert('Missing URL', 'Enter your Walnut server URL')
      return
    }
    if (!apiKey.trim()) {
      Alert.alert('Missing API Key', 'Enter your API key (starts with wlnt_sk_)')
      return
    }

    setTesting(true)
    const result = await testConnection(url.trim(), apiKey.trim())
    setTesting(false)

    if (result.ok) {
      setTested(true)
      Alert.alert('Connected!', 'Successfully connected to Walnut server')
    } else {
      setTested(false)
      Alert.alert('Connection Failed', result.error ?? 'Could not connect to server')
    }
  }

  const handleSave = async () => {
    if (!tested) {
      Alert.alert('Test First', 'Please test the connection before saving')
      return
    }
    await configure(url.trim(), apiKey.trim())
    router.replace('/(tabs)')
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.header}>
          <Ionicons name="leaf" size={48} color="#007AFF" />
          <Text style={styles.title}>Walnut</Text>
          <Text style={styles.subtitle}>Connect to your AI butler</Text>
        </View>

        <View style={styles.form}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(t) => { setUrl(t); setTested(false) }}
            placeholder="http://192.168.1.100:3456"
            placeholderTextColor="#8E8E93"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          <Text style={styles.label}>API Key</Text>
          <TextInput
            style={styles.input}
            value={apiKey}
            onChangeText={(t) => { setApiKey(t); setTested(false) }}
            placeholder="wlnt_sk_..."
            placeholderTextColor="#8E8E93"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />

          <TouchableOpacity
            style={[styles.button, styles.testButton]}
            onPress={handleTest}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#007AFF" />
            ) : (
              <>
                <Ionicons name={tested ? 'checkmark-circle' : 'wifi'} size={20} color="#007AFF" />
                <Text style={styles.testButtonText}>
                  {tested ? 'Connected' : 'Test Connection'}
                </Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.saveButton, !tested && styles.saveButtonDisabled]}
            onPress={handleSave}
            disabled={!tested}
          >
            <Text style={styles.saveButtonText}>Save & Connect</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.hint}>
          Generate an API key on your server:{'\n'}
          curl -X POST localhost:3456/api/auth/keys -H "Content-Type: application/json" -d '{`{"name":"iPhone"}`}'
        </Text>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#1C1C1E',
    marginTop: 12,
  },
  subtitle: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 4,
  },
  form: {
    gap: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3C3C43',
    marginTop: 4,
  },
  input: {
    height: 48,
    backgroundColor: '#F2F2F7',
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#1C1C1E',
  },
  button: {
    height: 48,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
  },
  testButton: {
    backgroundColor: '#F2F2F7',
  },
  testButtonText: {
    color: '#007AFF',
    fontSize: 16,
    fontWeight: '600',
  },
  saveButton: {
    backgroundColor: '#007AFF',
  },
  saveButtonDisabled: {
    opacity: 0.4,
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  hint: {
    marginTop: 32,
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
    lineHeight: 18,
  },
})
