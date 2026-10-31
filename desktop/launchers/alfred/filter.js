// The keyword's Script Filter: what is typed becomes a quick answer (Enter) or a message to Main
// (Cmd+Enter), and the tasks matching it list below (Enter opens one in Walnut).
function run(argv) {
  const entryId = String(Date.now())
  const query = (argv[0] || '').trim()
  if (!query) {
    return JSON.stringify({
      skipknowledge: true,
      items: [{
        title: 'Ask Walnut',
        subtitle: 'Type a question, a text to revise, or words of a task to find',
        valid: false,
        icon: { path: 'icon.png' },
      }],
    })
  }
  const items = [
    {
      uid: 'walnut-quick',
      title: query,
      subtitle: 'Quick answer ↵ · Tell Main ⌘↵',
      arg: query,
      icon: { path: 'icon.png' },
      variables: { walnut_kind: 'ask', walnut_mode: 'quick', walnut_entry: 'new', walnut_entry_id: entryId },
      mods: {
        cmd: {
          subtitle: "Tell Main: goes to Main's chat, and its reply shows here",
          arg: query,
          variables: { walnut_kind: 'ask', walnut_mode: 'main', walnut_entry: 'new', walnut_entry_id: entryId },
        },
      },
    },
  ]
  const res = walnutJson('GET', '/api/v1/quick/tasks?limit=6&q=' + encodeURIComponent(query), undefined, 1.5)
  if (res.status === 0) {
    items.push({ title: 'Walnut is not running', subtitle: NOT_RUNNING, valid: false, icon: { path: 'icon.png' } })
  }
  const tasks = (res.body && Array.isArray(res.body.tasks)) ? res.body.tasks : []
  for (const task of tasks) {
    items.push({
      uid: 'walnut-task-' + task.id,
      title: task.title,
      subtitle: task.stateLabel + (task.project ? ' · ' + task.project : '') + ' · ↵ open in Walnut',
      arg: openTaskLink(task.id),
      icon: { path: 'task.png' },
      variables: { walnut_kind: 'task' },
      text: { copy: task.title, largetype: task.title },
    })
  }
  return JSON.stringify({ skipknowledge: true, items: items })
}
