/**
 * Notes tab — folder tree flattened to an indented list with collapsible
 * folders, pull-to-refresh, note create (+), swipe-to-delete.
 */

import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Swipeable } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Banner } from '../../src/components/Banner'
import { EmptyState } from '../../src/components/EmptyState'
import { useConnectionStore } from '../../src/store/connection'
import { useNotesStore } from '../../src/store/notes'
import type { NoteTreeNode } from '../../src/api/types'
import { space, type, useTheme } from '../../src/theme'

interface Row {
  node: NoteTreeNode
  depth: number
}

/** Flatten the tree into rows, honoring collapsed folders; hide attachments. */
function flatten(nodes: NoteTreeNode[], collapsed: Set<string>, depth = 0): Row[] {
  const rows: Row[] = []
  for (const node of nodes) {
    if (node.type === 'file' && node.kind === 'attachment') continue
    rows.push({ node, depth })
    if (node.type === 'folder' && node.children && !collapsed.has(node.path)) {
      rows.push(...flatten(node.children, collapsed, depth + 1))
    }
  }
  return rows
}

export default function NotesScreen() {
  const { c } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const configured = useConnectionStore((s) => s.configured)
  const online = useConnectionStore((s) => s.online)
  const tree = useNotesStore((s) => s.tree)
  const loading = useNotesStore((s) => s.loadingTree)
  const error = useNotesStore((s) => s.error)
  const refreshTree = useNotesStore((s) => s.refreshTree)
  const createNote = useNotesStore((s) => s.create)
  const removeNote = useNotesStore((s) => s.remove)
  const clearError = useNotesStore((s) => s.clearError)

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (configured) void refreshTree()
  }, [configured])

  const rows = useMemo(() => flatten(tree, collapsed), [tree, collapsed])

  const toggleFolder = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const promptCreate = useCallback(() => {
    Alert.prompt(
      'New Note',
      'Name (use / for folders, e.g. Ideas/Trip)',
      async (name) => {
        const path = name?.trim().replace(/\.md$/i, '')
        if (!path) return
        const ok = await createNote(path)
        if (ok) router.push({ pathname: '/note/[...path]', params: { path: path.split('/') } })
      },
      'plain-text'
    )
  }, [createNote, router])

  const confirmDelete = useCallback(
    (path: string) => {
      Alert.alert('Delete Note', `Delete "${path}"? Git history keeps a copy.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void removeNote(path) },
      ])
    },
    [removeNote]
  )

  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      const { node, depth } = item
      const indent = space(2) + depth * space(2.5)

      if (node.type === 'folder') {
        const isCollapsed = collapsed.has(node.path)
        return (
          <Pressable
            onPress={() => toggleFolder(node.path)}
            style={({ pressed }) => [
              styles.row,
              { paddingLeft: indent, borderBottomColor: c.separator },
              pressed && { backgroundColor: c.secondaryBg },
            ]}
          >
            <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={14} color={c.tertiaryLabel} />
            <Ionicons name="folder-outline" size={18} color={c.tint} />
            <Text style={[styles.folderName, { color: c.label }]} numberOfLines={1}>
              {node.name}
            </Text>
          </Pressable>
        )
      }

      return (
        <Swipeable
          renderRightActions={() => (
            <Pressable style={[styles.deleteAction, { backgroundColor: c.danger }]} onPress={() => confirmDelete(node.path)}>
              <Ionicons name="trash-outline" size={20} color="#fff" />
            </Pressable>
          )}
          overshootRight={false}
        >
          <Pressable
            onPress={() => router.push({ pathname: '/note/[...path]', params: { path: node.path.split('/') } })}
            style={({ pressed }) => [
              styles.row,
              { paddingLeft: indent + 14 + 6, backgroundColor: c.bg, borderBottomColor: c.separator },
              pressed && { backgroundColor: c.secondaryBg },
            ]}
          >
            <Ionicons name="document-text-outline" size={18} color={c.secondaryLabel} />
            <Text style={[styles.noteName, { color: c.label }]} numberOfLines={1}>
              {node.name.replace(/\.md$/i, '')}
            </Text>
          </Pressable>
        </Swipeable>
      )
    },
    [c, collapsed, confirmDelete, router, toggleFolder]
  )

  return (
    <View style={[styles.container, { backgroundColor: c.bg, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: c.separator }]}>
        <Text style={[styles.headerTitle, { color: c.label }]}>Notes</Text>
        <Pressable onPress={promptCreate} hitSlop={10} style={({ pressed }) => pressed && { opacity: 0.5 }}>
          <Ionicons name="create-outline" size={24} color={c.tint} />
        </Pressable>
      </View>

      {!online && <Banner kind="warning" text="Offline — notes are read-only from cache" />}
      {error && <Banner kind="error" text={error} onDismiss={clearError} />}

      {rows.length === 0 && !loading ? (
        <EmptyState
          icon="document-text-outline"
          title="No notes yet"
          subtitle="Tap the compose button to write your first note."
        />
      ) : (
        <FlatList
          data={rows}
          renderItem={renderRow}
          keyExtractor={(r) => r.node.path}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={() => void refreshTree()} tintColor={c.tertiaryLabel} />
          }
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space(2),
    paddingVertical: space(1.25),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: type.title, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1),
    paddingVertical: 11,
    paddingRight: space(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  folderName: { fontSize: type.body, fontWeight: '500', flex: 1 },
  noteName: { fontSize: type.body, flex: 1 },
  deleteAction: {
    width: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
