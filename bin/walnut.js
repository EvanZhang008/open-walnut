#!/usr/bin/env node
// Compatibility forwarder: package.json's bin map points both `walnut` and
// `open-walnut` at open-walnut.js, but global installs linked before that
// change still resolve `walnut` to this file. One source of truth there.
import('./open-walnut.js');
