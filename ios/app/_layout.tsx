/**
 * Root layout — hydrates config, routes to Setup or Tabs, hosts the stack.
 */

import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import React, { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useConnectionStore } from '../src/store/connection'
import { useTheme } from '../src/theme'

export default function RootLayout() {
  const { c, isDark } = useTheme()
  const router = useRouter()
  const segments = useSegments()
  const hydrate = useConnectionStore((s) => s.hydrate)
  const hydrated = useConnectionStore((s) => s.hydrated)
  const configured = useConnectionStore((s) => s.configured)

  useEffect(() => {
    void hydrate()
  }, [])

  useEffect(() => {
    if (!hydrated) return
    const inSetup = segments[0] === 'setup'
    if (!configured && !inSetup) {
      router.replace('/setup')
    } else if (configured && inSetup) {
      router.replace('/(tabs)')
    }
  }, [hydrated, configured, segments])

  if (!hydrated) {
    return (
      <View style={[styles.loading, { backgroundColor: c.bg }]}>
        <ActivityIndicator size="large" color={c.tint} />
        <StatusBar style={isDark ? 'light' : 'dark'} />
      </View>
    )
  }

  return (
    <GestureHandlerRootView style={styles.flex}>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          headerTintColor: c.tint,
          headerStyle: { backgroundColor: c.bg },
          headerTitleStyle: { color: c.label, fontWeight: '600' },
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="setup" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="conversations"
          options={{
            headerShown: true,
            title: 'Conversations',
            presentation: 'modal',
          }}
        />
        <Stack.Screen
          name="note/[...path]"
          options={{
            headerShown: true,
            headerBackTitle: 'Notes',
          }}
        />
      </Stack>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
})
