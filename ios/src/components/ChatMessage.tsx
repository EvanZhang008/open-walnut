/**
 * Single chat message bubble — user (right) or assistant (left).
 * Renders markdown for assistant messages.
 */

import React, { memo } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { ChatMessage as ChatMessageType } from '../api/types'

interface Props {
  message: ChatMessageType
}

function ChatMessageInner({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <View style={[styles.row, isUser && styles.rowUser]}>
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        {isUser ? (
          <Text style={styles.userText}>{message.text}</Text>
        ) : (
          <Markdown style={markdownStyles}>
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
  code_inline: {
    backgroundColor: '#E8E8ED',
    color: '#1C1C1E',
    borderRadius: 4,
    paddingHorizontal: 4,
    fontFamily: 'Menlo',
    fontSize: 14,
  },
  fence: {
    backgroundColor: '#1C1C1E',
    color: '#F8F8F2',
    borderRadius: 8,
    padding: 12,
    fontFamily: 'Menlo',
    fontSize: 13,
    marginVertical: 8,
    overflow: 'hidden',
  },
  code_block: {
    backgroundColor: '#1C1C1E',
    color: '#F8F8F2',
    borderRadius: 8,
    padding: 12,
    fontFamily: 'Menlo',
    fontSize: 13,
  },
  heading1: {
    fontSize: 22,
    fontWeight: '700',
    marginVertical: 8,
  },
  heading2: {
    fontSize: 19,
    fontWeight: '600',
    marginVertical: 6,
  },
  heading3: {
    fontSize: 17,
    fontWeight: '600',
    marginVertical: 4,
  },
  strong: {
    fontWeight: '600',
  },
  link: {
    color: '#007AFF',
  },
  list_item: {
    marginVertical: 2,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
    paddingLeft: 12,
    opacity: 0.8,
    marginVertical: 4,
  },
})
