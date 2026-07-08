/**
 * Chat message rendering — user bubble (right, tinted), assistant markdown
 * (left, plain), and compact inline rows for tool/thinking history entries.
 */

import { Ionicons } from '@expo/vector-icons'
import React, { memo, useMemo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { ApiMessage } from '../api/types'
import { type, useTheme } from '../theme'
import { markdownStyles } from './markdown'

function MessageBubbleInner({ message }: { message: ApiMessage }) {
  const { c } = useTheme()
  const md = useMemo(() => markdownStyles(c), [c])

  // Tool / thinking steps render as a hairline status row, not a bubble.
  if (message.kind) {
    return (
      <View style={styles.activityRow}>
        <Ionicons
          name={message.kind === 'tool' ? 'construct-outline' : 'sparkles-outline'}
          size={12}
          color={c.tertiaryLabel}
        />
        <Text style={[styles.activityText, { color: c.tertiaryLabel }]} numberOfLines={1}>
          {message.text}
        </Text>
      </View>
    )
  }

  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        <View style={[styles.userBubble, { backgroundColor: c.tint, opacity: message.pending ? 0.65 : 1 }]}>
          <Text style={[styles.userText, { color: c.onTint }]}>{message.text}</Text>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.assistantRow}>
      <Markdown style={md} mergeStyle={false}>
        {message.text}
      </Markdown>
    </View>
  )
}

export const MessageBubble = memo(MessageBubbleInner)

const styles = StyleSheet.create({
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginVertical: 4,
    marginHorizontal: 16,
  },
  userBubble: {
    maxWidth: '82%',
    borderRadius: 18,
    borderBottomRightRadius: 5,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  userText: { fontSize: type.body, lineHeight: 23 },
  assistantRow: {
    marginVertical: 4,
    marginHorizontal: 16,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginVertical: 2,
  },
  activityText: { fontSize: type.caption, fontStyle: 'italic', flexShrink: 1 },
})
