// The Text View's modifier keys: the last answer (to paste or copy), or the link that opens
// Main in Walnut. WALNUT_ANSWER_KIND (answer | open) is set per object by build.mjs.
function run() {
  const dir = envVar('alfred_workflow_cache') || (envVar('HOME') + '/Library/Caches/walnut-alfred')
  const raw = readText(dir + '/chat.json')
  let chat = null
  try { chat = raw ? JSON.parse(raw) : null } catch (e) { chat = null }
  if (WALNUT_ANSWER_KIND === 'open') {
    return chat && chat.mainTaskId ? openTaskLink(chat.mainTaskId) : 'open-walnut://open?to=' + encodeURIComponent('/')
  }
  const answers = chat ? chat.messages.filter((m) => m.role === 'assistant' && m.text.indexOf('⚠️') !== 0) : []
  return answers.length ? answers[answers.length - 1].text : ''
}
