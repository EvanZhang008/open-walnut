/**
 * Chat tab — drops straight into the most recent conversation (butler feel).
 * History button (top-left) opens the conversation list sheet.
 */

import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Banner } from '../../src/components/Banner'
import { ChatComposer } from '../../src/components/ChatComposer'
import { EmptyState } from '../../src/components/EmptyState'
import { MessageBubble } from '../../src/components/MessageBubble'
import { StatusBadge } from '../../src/components/StatusBadge'
import { useChatStore } from '../../src/store/chat'
import { useConnectionStore } from '../../src/store/connection'
import type { ApiMessage } from '../../src/api/types'
import { type, useTheme } from '../../src/theme'

export default function ChatScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const listRef = useRef<FlatList<ApiMessage>>(null)

  const configured = useConnectionStore((s) => s.configured)
  const online = useConnectionStore((s) => s.online)
  const activeId = useChatStore((s) => s.activeId)
  const conversations = useChatStore((s) => s.conversations)
  const messagesByConv = useChatStore((s) => s.messages)
  const streaming = useChatStore((s) => s.streaming)
  const sending = useChatStore((s) => s.sending)
  const streamText = useChatStore((s) => s.streamText)
  const activity = useChatStore((s) => s.activity)
  const loadingMessages = useChatStore((s) => s.loadingMessages)
  const error = useChatStore((s) => s.error)

  const initialize = useChatStore((s) => s.initialize)
  const send = useChatStore((s) => s.send)
  const loadOlder = useChatStore((s) => s.loadOlder)
  const clearError = useChatStore((s) => s.clearError)
  const connectStream = useChatStore((s) => s.connectStream)
  const closeStream = useChatStore((s) => s.closeStream)

  useEffect(() => {
    if (!configured) return
    void initialize()
    connectStream()
    return () => closeStream()
  }, [configured])

  const messages = useMemo(() => {
    const base = activeId ? messagesByConv[activeId] ?? [] : []
    if (streaming && streamText) {
      return [
        ...base,
        { id: '__live__', role: 'assistant' as const, text: streamText, createdAt: '', streaming: true },
      ]
    }
    return base
  }, [activeId, messagesByConv, streaming, streamText])

  // Inverted list: newest at the visual bottom without scroll gymnastics.
  const inverted = useMemo(() => [...messages].reverse(), [messages])

  const title = useMemo(() => {
    const conv = conversations.find((cv) => cv.id === activeId)
    return conv?.title ?? 'Walnut'
  }, [conversations, activeId])

  const renderItem = useCallback(
    ({ item }: { item: ApiMessage }) => <MessageBubble message={item} />,
    []
  )

  return (
    <View style={[styles.container, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      {/* Header row: history + title + status */}
      <View style={[styles.header, { borderBottomColor: c.separator, backgroundColor: c.bg }]}>
        <Pressable
          onPress={() => router.push('/conversations')}
          hitSlop={10}
          style={({ pressed }) => [styles.headerButton, pressed && { opacity: 0.5 }]}
        >
          <Ionicons name="time-outline" size={24} color={c.tint} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: c.label }]} numberOfLines={1}>
          {title}
        </Text>
        <StatusBadge />
      </View>

      {!online && <Banner kind="warning" text="Offline — showing cached data" />}
      {error && <Banner kind="error" text={error} onDismiss={clearError} />}

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {loadingMessages && messages.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={c.tertiaryLabel} />
          </View>
        ) : messages.length === 0 ? (
          <EmptyState
            icon="chatbubble-ellipses-outline"
            title="Your butler is listening"
            subtitle="Ask anything — tasks, notes, or what happened today."
          />
        ) : (
          <FlatList
            ref={listRef}
            data={inverted}
            inverted
            renderItem={renderItem}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            onEndReached={() => void loadOlder()}
            onEndReachedThreshold={0.3}
            keyboardDismissMode="interactive"
            showsVerticalScrollIndicator={false}
          />
        )}

        <ChatComposer
          disabled={sending || streaming || !online}
          busy={sending || streaming}
          activity={activity}
          onSend={send}
        />
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerButton: { padding: 2 },
  headerTitle: {
    flex: 1,
    fontSize: type.body,
    fontWeight: '600',
    textAlign: 'center',
  },
  list: { paddingVertical: 12 },
})
