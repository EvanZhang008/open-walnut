/**
 * Theme-aware markdown styles for react-native-markdown-display.
 */

import { StyleSheet } from 'react-native'
import { mono, type Palette, type } from '../theme'

export function markdownStyles(c: Palette): StyleSheet.NamedStyles<Record<string, object>> {
  return {
    body: { color: c.label, fontSize: type.body, lineHeight: 24 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    heading1: { fontSize: type.title, fontWeight: '700', color: c.label, marginTop: 12, marginBottom: 6 },
    heading2: { fontSize: 19, fontWeight: '600', color: c.label, marginTop: 10, marginBottom: 4 },
    heading3: { fontSize: type.body, fontWeight: '600', color: c.label, marginTop: 8, marginBottom: 4 },
    strong: { fontWeight: '600' },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: c.tint, textDecorationLine: 'underline' },
    code_inline: {
      backgroundColor: c.tertiaryBg,
      color: c.label,
      borderRadius: 4,
      paddingHorizontal: 5,
      fontFamily: mono,
      fontSize: 14,
    },
    fence: {
      backgroundColor: c.tertiaryBg,
      color: c.label,
      borderRadius: 10,
      borderWidth: 0,
      padding: 12,
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 19,
      marginVertical: 8,
    },
    code_block: {
      backgroundColor: c.tertiaryBg,
      color: c.label,
      borderRadius: 10,
      borderWidth: 0,
      padding: 12,
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 19,
    },
    blockquote: {
      backgroundColor: 'transparent',
      borderLeftWidth: 3,
      borderLeftColor: c.tint,
      paddingLeft: 12,
      marginVertical: 6,
      opacity: 0.9,
    },
    bullet_list: { marginBottom: 8 },
    ordered_list: { marginBottom: 8 },
    list_item: { flexDirection: 'row', marginVertical: 2 },
    hr: { backgroundColor: c.separator, height: StyleSheet.hairlineWidth, marginVertical: 12 },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: c.separator, borderRadius: 8, marginVertical: 8 },
    thead: { backgroundColor: c.secondaryBg },
    th: { padding: 8, fontWeight: '600', fontSize: 14 },
    tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.separator, flexDirection: 'row' },
    td: { padding: 8, fontSize: 14 },
  }
}
