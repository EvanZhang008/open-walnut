/**
 * Push notification hook — registers for push and handles incoming notifications.
 *
 * In Expo Go on simulator, push tokens are not available (requires dev build).
 * This hook gracefully handles that case.
 */

import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { registerPushToken } from '../api/client'
import { setPushToken } from '../utils/secure-store'
import { useConnectionStore } from '../store/connection'

// Configure how notifications appear when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

export function usePush() {
  const connectionState = useConnectionStore((s) => s.connectionState)
  const notificationListener = useRef<Notifications.Subscription | null>(null)
  const responseListener = useRef<Notifications.Subscription | null>(null)

  useEffect(() => {
    // Only register when connected to server
    if (connectionState !== 'connected') return

    registerForPush()

    // Listen for incoming notifications (foreground)
    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      // Notification received while app is in foreground
      // Could update a badge count or show in-app banner
      console.log('Push received:', notification.request.content.title)
    })

    // Listen for notification taps (background → foreground)
    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data
      console.log('Push tapped:', data)
      // Could navigate to specific screen based on data.type
    })

    return () => {
      if (notificationListener.current) {
        Notifications.removeNotificationSubscription(notificationListener.current)
      }
      if (responseListener.current) {
        Notifications.removeNotificationSubscription(responseListener.current)
      }
    }
  }, [connectionState])
}

async function registerForPush(): Promise<void> {
  try {
    // Physical device check — push doesn't work in simulator
    if (!Device.isDevice) {
      console.log('Push: skipping registration (simulator)')
      return
    }

    // Request permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync()
    let finalStatus = existingStatus
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync()
      finalStatus = status
    }
    if (finalStatus !== 'granted') {
      console.log('Push: permission not granted')
      return
    }

    // Get Expo push token
    const tokenData = await Notifications.getExpoPushTokenAsync({
      projectId: undefined, // Uses app.json config
    })
    const token = tokenData.data
    console.log('Push token:', token)

    // Save locally
    await setPushToken(token)

    // Register with server
    await registerPushToken(token)
    console.log('Push: registered with server')
  } catch (err) {
    // Graceful degradation — push is nice-to-have, not critical
    console.log('Push registration failed:', err instanceof Error ? err.message : String(err))
  }
}
