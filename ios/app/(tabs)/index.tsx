/**
 * Chat screen — main interaction with AI agent.
 * Streaming messages, markdown rendering, send/stop.
 */

import React, { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  View,
  FlatList,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation } from 'expo-router'
import { ChatMessageView } from '../../src/components/ChatMessage'
import { ChatInput } from '../../src/components/ChatInput'
import { ConnectionBadge } from '../../src/components/ConnectionBadge'
import { useChatStore } from '../../src/store/chat'
import { useSettingsStore } from '../../src/store/settings'
import type { ChatMessage } from '../../src/api/types'

export default function ChatScreen() {
  const insets = useSafeAreaInsets()
  const navigation = useNavigation()
  const flatListRef = useRef<FlatList>(null)
  const allMessages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const isLoading = useChatStore((s) => s.isLoading)
  const error = useChatStore((s) => s.error)
  const hasMore = useChatStore((s) => s.hasMore)
  const taskContext = useChatStore((s) => s.taskContext)
  const initialize = useChatStore((s) => s.initialize)
  const loadOlderMessages = useChatStore((s) => s.loadOlderMessages)
  const showUiOnlyTriage = useSettingsStore((s) => s.showUiOnlyTriage)
  const loadSettings = useSettingsStore((s) => s.load)

  // Filter out UI-only triage messages unless developer setting is enabled
  const messages = useMemo(
    () => showUiOnlyTriage ? allMessages : allMessages.filter((m) => !(m.source === 'triage' && m.notification)),
    [allMessages, showUiOnlyTriage]
  )

  // Set header with connection badge
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View style={styles.headerTitle}>
          <Text style={styles.headerText}>Walnut</Text>
          <ConnectionBadge />
        </View>
      ),
    })
  }, [navigation])

  // Initialize chat and load settings on mount
  useEffect(() => {
    initialize()
    loadSettings()
  }, [])

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true })
      }, 100)
    }
  }, [messages.length, isStreaming])

  const renderMessage = useCallback(
    ({ item }: { item: ChatMessage }) => <ChatMessageView message={item} />,
    []
  )

  const handleEndReached = useCallback(() => {
    // FlatList inverted: "end" is actually the top (older messages)
    // But we're NOT using inverted, so we load older when scrolling up.
    // We'll use onScroll to detect reaching the top instead.
  }, [])

  const keyExtractor = useCallback((item: ChatMessage) => item.id, [])

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      {/* Task context bar */}
      {taskContext && (
        <View style={styles.contextBar}>
          <Text style={styles.contextText} numberOfLines={1}>
            Context: {taskContext.title}
          </Text>
        </View>
      )}

      {/* Messages */}
      {isLoading && messages.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={styles.loadingText}>Loading chat history...</Text>
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>🌰</Text>
          <Text style={styles.emptyTitle}>Start a Conversation</Text>
          <Text style={styles.emptySubtitle}>Ask Walnut anything</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={keyExtractor}
          contentContainerStyle={[styles.messageList, { paddingBottom: 8 }]}
          onScrollBeginDrag={() => {
            // Could load older messages on scroll to top
          }}
          onContentSizeChange={() => {
            // Auto scroll on new content
            if (isStreaming) {
              flatListRef.current?.scrollToEnd({ animated: false })
            }
          }}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Error banner */}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {/* Input */}
      <ChatInput />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  headerTitle: {
    alignItems: 'center',
    gap: 2,
  },
  headerText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  contextBar: {
    backgroundColor: '#F0F0FF',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E5E5EA',
  },
  contextText: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '500',
  },
  messageList: {
    paddingTop: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 15,
    color: '#8E8E93',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  emptySubtitle: {
    fontSize: 15,
    color: '#8E8E93',
  },
  errorBanner: {
    backgroundColor: '#FFF0F0',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#FF3B30',
  },
  errorText: {
    fontSize: 13,
    color: '#FF3B30',
  },
})
