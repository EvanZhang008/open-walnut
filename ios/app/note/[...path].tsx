/**
 * Note editor — clean markdown source editing with debounced autosave and
 * optimistic locking. On a 409 conflict the server version wins (LWW) and a
 * non-blocking banner explains the reload.
 */

import { Stack, useLocalSearchParams } from 'expo-router'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Banner } from '../../src/components/Banner'
import { useConnectionStore } from '../../src/store/connection'
import { useNotesStore } from '../../src/store/notes'
import { type, useTheme } from '../../src/theme'

const AUTOSAVE_MS = 1200

export default function NoteEditorScreen() {
  const { c } = useTheme()
  const params = useLocalSearchParams<{ path: string[] | string }>()
  const path = Array.isArray(params.path) ? params.path.join('/') : params.path ?? ''
  const title = path.split('/').pop() ?? path

  const online = useConnectionStore((s) => s.online)
  const loadNote = useNotesStore((s) => s.loadNote)
  const save = useNotesStore((s) => s.save)
  const saving = useNotesStore((s) => s.saving)

  const [content, setContent] = useState<string | null>(null)
  const [conflictNotice, setConflictNotice] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const contentRef = useRef<string | null>(null)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const note = await loadNote(path)
      if (cancelled) return
      if (note) {
        setContent(note.content)
        contentRef.current = note.content
      } else {
        setLoadFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  const flushSave = useCallback(async () => {
    if (!dirtyRef.current || contentRef.current == null) return
    dirtyRef.current = false
    const result = await save(path, contentRef.current)
    if (result?.conflicted) {
      // Server version adopted (LWW) — reload editor, tell the user gently.
      setContent(result.content)
      contentRef.current = result.content
      setConflictNotice(true)
      setTimeout(() => setConflictNotice(false), 5000)
    }
  }, [path, save])

  const handleChange = useCallback(
    (text: string) => {
      setContent(text)
      contentRef.current = text
      dirtyRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void flushSave(), AUTOSAVE_MS)
    },
    [flushSave]
  )

  // Save on unmount (screen pop) if edits are pending.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void flushSave()
    }
  }, [flushSave])

  return (
    <View style={[styles.container, { backgroundColor: c.bg }]}>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (saving ? <ActivityIndicator size="small" color={c.tertiaryLabel} /> : null),
        }}
      />

      {conflictNotice && <Banner kind="info" text="Updated elsewhere — reloaded with the latest version" />}
      {!online && <Banner kind="warning" text="Offline — edits may not save" />}

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
        {content == null ? (
          loadFailed ? (
            <View style={styles.center}>
              <Text style={{ color: c.secondaryLabel, fontSize: type.footnote }}>Couldn't load this note.</Text>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={c.tertiaryLabel} />
            </View>
          )
        ) : (
          <TextInput
            style={[styles.editor, { color: c.label }]}
            value={content}
            onChangeText={handleChange}
            onBlur={() => {
              if (timerRef.current) clearTimeout(timerRef.current)
              void flushSave()
            }}
            multiline
            autoCapitalize="sentences"
            autoCorrect
            textAlignVertical="top"
            placeholder="Start writing…"
            placeholderTextColor={c.tertiaryLabel}
            editable={online}
            scrollEnabled
          />
        )}
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  editor: {
    flex: 1,
    fontSize: type.body,
    lineHeight: 26,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 40,
  },
})
