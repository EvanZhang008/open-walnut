/**
 * Single chat message bubble — user (right) or assistant (left).
 * Renders markdown for assistant messages with source badges.
 */

import React, { memo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { ChatMessage as ChatMessageType } from '../api/types'

interface Props {
  message: ChatMessageType
}

/** Badge label for message source (triage, cron, session, etc.) */
function sourceLabel(source?: string): string | null {
  switch (source) {
    case 'triage': return 'Triage'
    case 'cron': return 'Scheduled'
    case 'session': return 'Session'
    case 'session-error': return 'Session Error'
    case 'agent-error': return 'Error'
    case 'subagent': return 'Sub-agent'
    case 'heartbeat': return 'Heartbeat'
    default: return null
  }
}

function ChatMessageInner({ message }: Props) {
  const isUser = message.role === 'user'
  const badge = !isUser ? sourceLabel(message.source) : null

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        {badge && (
          <View style={styles.badgeRow}>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          </View>
        )}
        {isUser ? (
          <Text style={styles.userText}>{message.text}</Text>
        ) : (
          <Markdown style={markdownStyles} mergeStyle>
            {message.text || (message.isStreaming ? '...' : '')}
          </Markdown>
        )}
        {message.isStreaming && (
          <Text style={styles.streamingDot}>●</Text>
        )}
      </View>
    </View>
  )
}

export const ChatMessageView = memo(ChatMessageInner)

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    marginVertical: 4,
    marginHorizontal: 12,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: '#007AFF',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#F0F0F0',
    borderBottomLeftRadius: 4,
  },
  userText: {
    color: '#FFFFFF',
    fontSize: 16,
    lineHeight: 22,
  },
  badgeRow: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  badge: {
    backgroundColor: '#E8E8ED',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8E8E93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  streamingDot: {
    color: '#007AFF',
    fontSize: 10,
    marginTop: 4,
    opacity: 0.6,
  },
})

const markdownStyles = StyleSheet.create({
  body: {
    color: '#1C1C1E',
    fontSize: 16,
    lineHeight: 22,
  },
  // Inline code
  code_inline: {
    backgroundColor: '#E8E8ED',
    color: '#1C1C1E',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: 'Menlo',
    fontSize: 14,
  },
  // Fenced code blocks (```)
  fence: {
    backgroundColor: '#1C1C1E',
    color: '#F8F8F2',
    borderRadius: 10,
    padding: 12,
    fontFamily: 'Menlo',
    fontSize: 13,
    lineHeight: 18,
    marginVertical: 8,
    overflow: 'hidden',
  },
  code_block: {
    backgroundColor: '#1C1C1E',
    color: '#F8F8F2',
    borderRadius: 10,
    padding: 12,
    fontFamily: 'Menlo',
    fontSize: 13,
    lineHeight: 18,
  },
  // Headings
  heading1: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1C1C1E',
    marginTop: 12,
    marginBottom: 6,
  },
  heading2: {
    fontSize: 19,
    fontWeight: '600',
    color: '#1C1C1E',
    marginTop: 10,
    marginBottom: 4,
  },
  heading3: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1C1C1E',
    marginTop: 8,
    marginBottom: 4,
  },
  // Text styles
  strong: {
    fontWeight: '700',
  },
  em: {
    fontStyle: 'italic',
  },
  s: {
    textDecorationLine: 'line-through',
  },
  // Links
  link: {
    color: '#007AFF',
    textDecorationLine: 'underline',
  },
  // Lists
  bullet_list: {
    marginVertical: 4,
  },
  ordered_list: {
    marginVertical: 4,
  },
  list_item: {
    flexDirection: 'row',
    marginVertical: 2,
  },
  // Blockquote
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
    paddingLeft: 12,
    marginVertical: 6,
    opacity: 0.85,
  },
  // Table
  table: {
    borderWidth: 1,
    borderColor: '#D1D1D6',
    borderRadius: 8,
    marginVertical: 8,
    overflow: 'hidden',
  },
  thead: {
    backgroundColor: '#E8E8ED',
  },
  th: {
    padding: 8,
    fontWeight: '600',
    fontSize: 14,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D1D6',
  },
  tr: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D1D6',
    flexDirection: 'row',
  },
  td: {
    padding: 8,
    fontSize: 14,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: '#D1D1D6',
  },
  // Horizontal rule
  hr: {
    backgroundColor: '#D1D1D6',
    height: 1,
    marginVertical: 12,
  },
  // Paragraph spacing
  paragraph: {
    marginVertical: 4,
  },
})
