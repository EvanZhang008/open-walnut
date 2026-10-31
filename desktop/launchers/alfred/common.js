// Shared by the Walnut Alfred workflow's scripts (build.mjs puts this file in front of each).
// JavaScript for Automation: it runs on every Mac with no runtime to install, and talks to the
// local Walnut server with curl (a loopback caller needs no token).
ObjC.import('Foundation')

function envVar(name) {
  const value = $.NSProcessInfo.processInfo.environment.objectForKey(name)
  return value.isNil() ? '' : value.js
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * Run a program and return what it printed. NSTask, not doShellScript: loading Standard
 * Additions costs about a second, and the Script Filter runs on every keystroke.
 */
function exec(path, args) {
  const task = $.NSTask.alloc.init
  const pipe = $.NSPipe.pipe
  task.launchPath = path
  task.arguments = args
  task.standardOutput = pipe
  task.standardError = $.NSFileHandle.fileHandleWithNullDevice
  task.launch
  const data = pipe.fileHandleForReading.readDataToEndOfFile
  task.waitUntilExit
  const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  return text.isNil() ? '' : text.js
}

function sh(command) {
  return exec('/bin/sh', ['-c', command])
}

function walnutPort() {
  const port = parseInt(envVar('walnut_port'), 10)
  return port > 0 && port < 65536 ? port : 3456
}

function walnutBase() {
  return 'http://127.0.0.1:' + walnutPort()
}

function readText(path) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null)
  return text.isNil() ? null : text.js
}

function writeText(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)
}

function fileExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path)
}

function removeFile(path) {
  $.NSFileManager.defaultManager.removeItemAtPathError(path, null)
}

function makeDir(path) {
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(path, true, $(), null)
}

/** One JSON request to Walnut; `{ ok, status, body }`, `ok: false, status: 0` when nothing answered. */
function walnutJson(method, path, body, timeoutSeconds) {
  const args = ['-sS', '--max-time', String(timeoutSeconds || 5), '-X', method,
    '-H', 'content-type: application/json', '-w', '\n%{http_code}']
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body))
  args.push(walnutBase() + path)
  const out = exec('/usr/bin/curl', args)
  const cut = out.lastIndexOf('\n')
  const status = cut >= 0 ? (parseInt(out.slice(cut + 1), 10) || 0) : 0
  let parsed = null
  try { parsed = JSON.parse(out.slice(0, cut)) } catch (e) { parsed = null }
  return { ok: status >= 200 && status < 300, status: status, body: parsed }
}

function openTaskLink(taskId) {
  return 'open-walnut://open?to=' + encodeURIComponent('/tasks/' + taskId)
}

const NOT_RUNNING = 'Walnut is not answering on port ' + walnutPort() + '. Open the Walnut app, then try again.'
