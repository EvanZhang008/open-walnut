// Entries other than the keyword: the hotkey and the Universal Action (the selected text), the
// fallback search, and Cmd+Enter in the Text View (a new conversation). Each gives the Text View
// a new entry id and what came with it. WALNUT_ENTRY_KIND is set per object by build.mjs.
function run(argv) {
  const text = argv[0] || ''
  const selection = WALNUT_ENTRY_KIND === 'selection'
  const fresh = WALNUT_ENTRY_KIND === 'new-chat'
  return JSON.stringify({
    alfredworkflow: {
      arg: selection || fresh ? '' : text,
      variables: {
        walnut_mode: fresh ? (envVar('walnut_mode') || 'quick') : 'quick',
        walnut_entry: selection ? 'selection' : 'new',
        walnut_entry_fresh: fresh ? '1' : '',
        walnut_entry_id: String(Date.now()),
        walnut_selection: selection ? text : '',
        walnut_app: selection ? envVar('walnut_app') : '',
      },
    },
  })
}
