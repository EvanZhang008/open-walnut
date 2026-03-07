/**
 * Single chat message bubble — user (right) or assistant (left).
 * Renders markdown for assistant messages with source badges.
 * Triage/notification messages auto-collapse to a compact summary row.
 */

import React, { memo, useState, useMemo } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import Markdown from 'react-native-markdown-display'
import type { ChatMessage as ChatMessageType } from '../api/types'

interface Props {
  message: ChatMessageType
}

/** Badge label for message source */
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

/** Should this message source auto-collapse? */
function shouldAutoCollapse(source?: string): boolean {
  return source === 'triage' || source === 'subagent' || source === 'heartbeat'
}

/** Extract a compact summary for collapsed triage/notification messages.
 *  Matches the web UI logic: task label + phase/summary. */
function extractCollapsedSummary(text: string): string {
  // After transformEntityRefs, task-refs are bold: **Task Name**
  // Pattern: **Triage** (**Task Name**): → extract Task Name
  const triageTaskMatch = text.match(/\*\*Triage\*\*\s*\(\*\*([^*]+)\*\*\)/)
  if (triageTaskMatch) {
    const taskName = triageTaskMatch[1]
    // Try to find a brief summary after the task name
    const afterHeader = text.slice(triageTaskMatch.index! + triageTaskMatch[0].length)
    // Look for "→ AI:" notify message
    const notifyMatch = afterHeader.match(/>\s*\*\*→ AI:\*\*\s*(.+)/)
    if (notifyMatch) return `${taskName} — ${notifyMatch[1].trim()}`.slice(0, 150)
    // Look for classification
    const classMatch = afterHeader.match(/(?:CONTINUE|REDIRECT|BLOCK|MILESTONE|ERROR)/i)
    if (classMatch) return `${taskName} — ${classMatch[0]}`.slice(0, 150)
    return taskName.slice(0, 150)
  }

  // Fallback: first bold text as title
  const boldMatch = text.match(/\*\*([^*]+)\*\*/)
  if (boldMatch) {
    const title = boldMatch[1]
    // Get first non-empty line after
    const rest = text.slice(boldMatch.index! + boldMatch[0].length)
    const nextLine = rest.split('\n').find(l => l.trim() && !l.startsWith('*'))
    if (nextLine) return `${title} — ${nextLine.trim().replace(/\*\*/g, '')}`.slice(0, 150)
    return title.slice(0, 150)
  }

  // Last fallback: first line stripped of markdown
  const firstLine = text.split('\n').find(l => l.trim()) ?? ''
  return firstLine.replace(/\*\*/g, '').replace(/\*/g, '').slice(0, 120)
}

function ChatMessageInner({ message }: Props) {
  const isUser = message.role === 'user'
  const badge = !isUser ? sourceLabel(message.source) : null
  const collapsible = !isUser && shouldAutoCollapse(message.source)
  const [collapsed, setCollapsed] = useState(collapsible)

  const summary = useMemo(
    () => collapsible ? extractCollapsedSummary(message.text) : '',
    [collapsible, message.text]
  )

  // Collapsed notification row
  if (collapsible && collapsed) {
    return (
      <TouchableOpacity
        style={styles.collapsedRow}
        onPress={() => setCollapsed(false)}
        activeOpacity={0.7}
      >
        <View style={styles.collapsedBorder} />
        <View style={styles.collapsedContent}>
          <View style={styles.collapsedTop}>
            {badge && (
              <Text style={styles.collapsedBadge}>{badge.toUpperCase()}</Text>
            )}
            <Text style={styles.collapsedSummary} numberOfLines={2}>
              {summary}
            </Text>
          </View>
          <Text style={styles.collapsedArrow}>{'\u25B6'}</Text>
        </View>
      </TouchableOpacity>
    )
  }

  // Expanded notification (tappable header to re-collapse)
  if (collapsible && !collapsed) {
    return (
      <View style={styles.expandedNotification}>
        <TouchableOpacity
          style={styles.expandedHeader}
          onPress={() => setCollapsed(true)}
          activeOpacity={0.7}
        >
          <View style={styles.collapsedBorder} />
          <View style={styles.collapsedContent}>
            <View style={styles.collapsedTop}>
              {badge && (
                <Text style={styles.collapsedBadge}>{badge.toUpperCase()}</Text>
              )}
              <Text style={styles.collapsedSummary} numberOfLines={1}>
                {summary}
              </Text>
            </View>
            <Text style={styles.collapsedArrow}>{'\u25BC'}</Text>
          </View>
        </TouchableOpacity>
        <View style={styles.expandedBody}>
          <Markdown style={markdownStyles} mergeStyle>
            {message.text}
          </Markdown>
        </View>
      </View>
    )
  }

  // Normal message bubble (user or non-notification assistant)
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
          <Text style={styles.streamingDot}>{'\u25CF'}</Text>
        )}
      </View>
    </View>
  )
}

export const ChatMessageView = memo(ChatMessageInner)

// ── Styles ──

const styles = StyleSheet.create({
  // Normal message styles
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

  // Collapsed notification styles
  collapsedRow: {
    flexDirection: 'row',
    marginVertical: 3,
    marginHorizontal: 12,
    backgroundColor: '#F8F8FA',
    borderRadius: 10,
    overflow: 'hidden',
  },
  collapsedBorder: {
    width: 3,
    backgroundColor: '#007AFF',
  },
  collapsedContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  collapsedTop: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 0,
  },
  collapsedBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#007AFF',
    letterSpacing: 0.5,
  },
  collapsedSummary: {
    flex: 1,
    fontSize: 13,
    color: '#8E8E93',
    lineHeight: 18,
  },
  collapsedArrow: {
    fontSize: 10,
    color: '#C7C7CC',
  },

  // Expanded notification styles
  expandedNotification: {
    marginVertical: 3,
    marginHorizontal: 12,
    backgroundColor: '#F8F8FA',
    borderRadius: 10,
    overflow: 'hidden',
  },
  expandedHeader: {
    flexDirection: 'row',
  },
  expandedBody: {
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
  },
})

// ── Markdown styles ──

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
    paddingHorizontal: 5,
    paddingVertical: 1,
    fontFamily: 'Menlo',
    fontSize: 14,
  },
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
  strong: {
    fontWeight: '700',
  },
  em: {
    fontStyle: 'italic',
  },
  s: {
    textDecorationLine: 'line-through',
  },
  link: {
    color: '#007AFF',
    textDecorationLine: 'underline',
  },
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
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
    paddingLeft: 12,
    marginVertical: 6,
    opacity: 0.85,
  },
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
  hr: {
    backgroundColor: '#D1D1D6',
    height: 1,
    marginVertical: 12,
  },
  paragraph: {
    marginVertical: 4,
  },
})
