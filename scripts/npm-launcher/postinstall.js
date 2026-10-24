// npm runs this after it installs open-walnut: the install is good only when
// this machine's compiled Walnut came with it. npm finishes an install without
// an optional dependency it could not get (a registry that does not serve it
// yet), and an update from a Node release (0.6.x) restarts into the launcher
// without checking, so a launcher without its file would leave nothing that
// starts. When the file is missing it is fetched here (lib/fetch-platform.js);
// when that fails too, this exits 1, so npm fails the install and puts back the
// version installed before (npm 10, 11 and 12 all do), which keeps running and
// tries again on its next start. CommonJS, ES2017 and Node 8 APIs, as launch.js.
'use strict'
// Before anything newer than ES5 loads: an old Node fails the install with one line.
if (parseInt(process.versions.node.split('.')[0], 10) < 8) {
  process.stderr.write('open-walnut: Node.js ' + process.versions.node + ' is too old for this package (it needs Node.js 8 or newer). Walnut itself needs no Node: curl -fsSL https://github.com/EvanZhang008/open-walnut/releases/latest/download/install.sh | sh\n')
  process.exit(1)
}
const fs = require('fs')
const path = require('path')
// Absolute paths: Node 8 and 10 read the working directory for a relative one, and it may be gone.
const launcher = require(path.join(__dirname, 'launch.js'))
const fetcher = require(path.join(__dirname, 'fetch-platform.js'))

const root = path.dirname(__dirname)
const fail = (line) => {
  process.stderr.write(`open-walnut: ${line}\nThe install stops here, so the Walnut installed before stays as it was.\n`)
  process.exit(1)
}

function main() {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const targets = launcher.candidateTargets()
  if (targets.length === 0) return fail(`Walnut runs on macOS and Linux (arm64 and x64); there is no build for ${process.platform}-${process.arch}.`)
  const found = launcher.findFile(targets, __dirname)
  if (found && found.unreadable) return fail(launcher.unreadableLine(found.unreadable))
  if (found) return
  const log = (l) => process.stderr.write(`open-walnut: ${l}\n`)
  // npm fetches it first (npm_execpath: the npm running this), so the settings it has apply.
  fetcher.fetchPlatformPackage({ packageRoot: root, target: targets[0], version, log }).then(() => {
    process.stderr.write(`open-walnut: npm left out ${fetcher.SCOPE}/${targets[0]}@${version}; it is installed now.\n`)
  }, (err) => {
    fail(`npm did not install ${fetcher.SCOPE}/${targets[0]}@${version}, the Walnut for this machine, and fetching it failed: ${err instanceof Error ? err.message : String(err)}. A release whose packages are still reaching the registry installs in a few minutes; otherwise run: ${launcher.reinstallCommand(root, version)}`)
  })
}

main()
