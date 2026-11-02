// The This PC page: how this PC's Walnut is doing (`walnut net status` in its Linux).
const api = window.walnutApp
const $ = (id) => document.getElementById(id)
async function refresh() {
  $('status').textContent = 'Reading...'
  const s = await api.pcStatus()
  if (!s) return
  $('status').textContent = s.lines.join('\n')
  if (s.joined) {
    $('title').textContent = 'This PC is one of your Walnut machines'
    $('lead').textContent = 'Your Walnut runs its sessions here when you pick this PC for a task. Walnut keeps running in WSL when this window is closed, and starts when you sign in to Windows.'
  } else {
    $('title').textContent = 'This PC is not joined to a Walnut'
    $('lead').textContent = 'The join did not finish, or this PC was taken off. Set up again to add it with a new link from your Mac, or to use Walnut on this PC.'
  }
  $('setup-again').className = s.joined ? '' : 'primary'
  $('open').hidden = !(s.joined && s.origin)
  $('open-hint').hidden = !(s.joined && s.origin)
}
$('refresh').addEventListener('click', refresh)
$('open').addEventListener('click', () => api.openWalnut())
$('setup-again').addEventListener('click', () => api.setupAgain())
refresh()
setInterval(refresh, 60000)
