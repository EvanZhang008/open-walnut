#!/usr/bin/env node
// Onboarding fixture: stands in for the npm build of Claude Code.
//
// The image has no Node.js, so the kernel's shebang lookup fails before this
// line is read and the caller sees `env: 'node': No such file or directory`,
// exactly like the real npm build on a host without node. If this body ever
// RUNS, a JavaScript runtime reached the fixture, and the test must say so
// rather than pass on a fake success.
console.error('onboarding fixture: a node runtime executed the fake claude; the image must not have one')
process.exit(97)
