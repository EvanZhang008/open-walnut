/**
 * Root layout — initializes app, checks auth, routes to Setup or Tabs.
 */

import React, { useEffect, useState } from 'react'
import { View, ActivityIndicator, StyleSheet } from 'react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useConnectionStore } from '../src/store/connection'
import { usePush } from '../src/hooks/usePush'

export default function RootLayout() {
  // Register for push notifications when connected
  usePush()
  const router = useRouter()
  const segments = useSegments()
  const initialize = useConnectionStore((s) => s.initialize)
  const isInitialized = useConnectionStore((s) => s.isInitialized)
  const isConfigured = useConnectionStore((s) => s.isConfigured)

  useEffect(() => {
    initialize()
  }, [])

  useEffect(() => {
    if (!isInitialized) return

    const inSetup = segments[0] === 'setup'

    if (!isConfigured && !inSetup) {
      router.replace('/setup')
    } else if (isConfigured && inSetup) {
      router.replace('/(tabs)')
    }
  }, [isInitialized, isConfigured, segments])

  if (!isInitialized) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#007AFF" />
        <StatusBar style="auto" />
      </View>
    )
  }

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="setup" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </>
  )
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
})
