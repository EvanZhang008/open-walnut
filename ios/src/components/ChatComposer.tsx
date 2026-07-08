/**
 * Chat input bar — rounded field + send button; disabled during active turns
 * with a subtle "thinking" indicator. Haptic tick on send.
 */

import { Ionicons } from '@expo/vector-icons'
import * as Haptics from 'expo-haptics'
import React, { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { type, useTheme } from '../theme'

interface Props {
  disabled: boolean
  busy: boolean
  activity: string | null
  onSend: (text: string) => Promise<boolean>
}

export function ChatComposer({ disabled, busy, activity, onSend }: Props) {
  const { c } = useTheme()
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim().length > 0

  const handleSend = async () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
    setText('')
    const ok = await onSend(trimmed)
    if (!ok) setText(trimmed) // restore draft on failure
  }

  return (
    <View style={[styles.wrap, { backgroundColor: c.bg, borderTopColor: c.separator }]}>
      {busy && (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={c.tertiaryLabel} />
          <Text style={[styles.busyText, { color: c.tertiaryLabel }]} numberOfLines={1}>
            {activity ? `${activity}…` : 'Thinking…'}
          </Text>
        </View>
      )}
      <View style={styles.row}>
        <TextInput
          style={[styles.input, { backgroundColor: c.secondaryBg, color: c.label }]}
          value={text}
          onChangeText={setText}
          placeholder={busy ? 'Waiting for reply…' : 'Message Walnut'}
          placeholderTextColor={c.tertiaryLabel}
          multiline
          maxLength={10000}
          editable={!disabled}
        />
        <Pressable
          onPress={handleSend}
          disabled={!canSend}
          style={({ pressed }) => [styles.sendButton, pressed && { opacity: 0.6 }]}
          hitSlop={8}
        >
          <View style={[styles.sendCircle, { backgroundColor: canSend ? c.tint : c.tertiaryBg }]}>
            <Ionicons name="arrow-up" size={19} color={canSend ? c.onTint : c.tertiaryLabel} />
          </View>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 6,
    paddingBottom: 6,
  },
  busyText: { fontSize: type.caption, fontStyle: 'italic' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 130,
    borderRadius: 19,
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 9,
    fontSize: type.body,
    lineHeight: 21,
  },
  sendButton: { paddingBottom: 3 },
  sendCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
