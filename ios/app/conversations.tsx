/**
 * Conversation history — modal sheet with recent conversations + new chat.
 */

import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useEffect } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { EmptyState } from '../src/components/EmptyState'
import { useChatStore } from '../src/store/chat'
import type { ConversationSummary } from '../src/api/types'
import { space, type, useTheme } from '../src/theme'

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString()
}

export default function ConversationsScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const conversations = useChatStore((s) => s.conversations)
  const activeId = useChatStore((s) => s.activeId)
  const loading = useChatStore((s) => s.loadingList)
  const refresh = useChatStore((s) => s.refreshConversations)
  const select = useChatStore((s) => s.select)
  const startNew = useChatStore((s) => s.startNewConversation)

  useEffect(() => {
    void refresh()
  }, [])

  const open = (id: string) => {
    select(id)
    router.back()
  }

  const renderItem = ({ item }: { item: ConversationSummary }) => {
    const active = item.id === activeId
    return (
      <Pressable
        onPress={() => open(item.id)}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: c.separator },
          pressed && { backgroundColor: c.secondaryBg },
        ]}
      >
        <View style={styles.rowBody}>
          <Text
            style={[styles.rowTitle, { color: c.label }, active && { color: c.tint, fontWeight: '600' }]}
            numberOfLines={1}
          >
            {item.title ?? 'New conversation'}
          </Text>
          <Text style={[styles.rowMeta, { color: c.tertiaryLabel }]}>
            {item.messageCount} messages
          </Text>
        </View>
        <Text style={[styles.rowTime, { color: c.tertiaryLabel }]}>{relativeTime(item.updatedAt)}</Text>
      </Pressable>
    )
  }

  return (
    <View style={[styles.container, { backgroundColor: c.bg }]}>
      {/* New conversation */}
      <Pressable
        onPress={() => {
          startNew()
          router.back()
        }}
        style={({ pressed }) => [
          styles.newRow,
          { borderBottomColor: c.separator },
          pressed && { backgroundColor: c.secondaryBg },
        ]}
      >
        <View style={[styles.newIcon, { backgroundColor: c.tintSoft }]}>
          <Ionicons name="add" size={20} color={c.tint} />
        </View>
        <Text style={[styles.newText, { color: c.tint }]}>New conversation</Text>
      </Pressable>

      {conversations.length === 0 ? (
        <EmptyState
          icon="chatbubbles-outline"
          title="No conversations yet"
          subtitle="Start one and it will appear here."
        />
      ) : (
        <FlatList
          data={conversations}
          renderItem={renderItem}
          keyExtractor={(cv) => cv.id}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={c.tertiaryLabel} />
          }
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  newRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    paddingHorizontal: space(2),
    paddingVertical: space(1.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  newIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  newText: { fontSize: type.body, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space(2),
    paddingVertical: space(1.5),
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space(1),
  },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { fontSize: type.body },
  rowMeta: { fontSize: type.caption },
  rowTime: { fontSize: type.caption },
})
