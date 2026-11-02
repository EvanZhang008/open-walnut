// Starting the console, or why it did not start.
const q = new URLSearchParams(location.search)
if (q.get('probing')) {
  document.getElementById('waiting-title').textContent = 'Opening Walnut'
  document.getElementById('waiting-lead').textContent = 'Looking at what is set up on this PC.'
}
if (q.get('failed')) {
  document.getElementById('waiting').hidden = true
  document.getElementById('failed').hidden = false
  window.walnutApp.info().then((i) => { if (i) document.getElementById('log-path').textContent = 'Log: ' + i.log })
}
document.getElementById('retry').addEventListener('click', () => window.walnutApp.retryConsole())
document.getElementById('setup-again').addEventListener('click', () => window.walnutApp.setupAgain())
