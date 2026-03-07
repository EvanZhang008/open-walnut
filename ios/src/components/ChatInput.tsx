/**
 * Chat input bar — text field + Send/Stop button.
 */

import React, { useState, useRef } from 'react'
import { View, TextInput, TouchableOpacity, StyleSheet, Keyboard } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useChatStore } from '../store/chat'

export function ChatInput() {
  const [text, setText] = useState('')
  const inputRef = useRef<TextInput>(null)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    sendMessage(trimmed)
    setText('')
    Keyboard.dismiss()
  }

  const handleStop = () => {
    stopGeneration()
  }

  return (
    <View style={styles.container}>
      <TextInput
        ref={inputRef}
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message Walnut..."
        placeholderTextColor="#8E8E93"
        multiline
        maxLength={10000}
        returnKeyType="default"
        blurOnSubmit={false}
        editable={!isStreaming}
      />
      {isStreaming ? (
        <TouchableOpacity onPress={handleStop} style={styles.stopButton}>
          <Ionicons name="stop-circle" size={32} color="#FF3B30" />
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          onPress={handleSend}
          style={[styles.sendButton, !text.trim() && styles.sendButtonDisabled]}
          disabled={!text.trim()}
        >
          <Ionicons name="arrow-up-circle-sharp" size={32} color={text.trim() ? '#007AFF' : '#C7C7CC'} />
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E5E5EA',
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 36,
    maxHeight: 120,
    backgroundColor: '#F2F2F7',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 8,
    fontSize: 16,
    color: '#1C1C1E',
  },
  sendButton: {
    paddingBottom: 2,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  stopButton: {
    paddingBottom: 2,
  },
})
