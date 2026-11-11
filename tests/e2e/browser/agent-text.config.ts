import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from '@playwright/test'
import base from '../../../playwright.config'
import { bunCommand } from '../../helpers/bun-runtime'
import { CHROMIUM_SILENT } from './pw-silence.js'
import './pw-webkit-paint.js'
import { testMatchNames } from './side-config-specs.js'

// Importing pw-silence silences every page of this run; the Chromium projects come from the base config.
void CHROMIUM_SILENT

const root = path.resolve(import.meta.dirname, '../../..')
process.env.PW_AGENT_TEXT_ENTRIES = '1'
process.env.PW_BUILT_SPA = '1'
process.env.WALNUT_WEB_STATIC_DIR = path.join(root, 'dist/web/static')

// The main config leaves every side config's specs out (side-config-specs.ts), and the projects it hands
// down carry that list: this config's own specs come off it, or none would run here.
const own = new Set(testMatchNames(fs.readFileSync(import.meta.filename, 'utf8')).map((name) => `**/${name}`))
const withoutOwn = (ignore: unknown) => (Array.isArray(ignore) ? ignore.filter((glob) => !own.has(String(glob))) : ignore)

export default defineConfig({
  ...base,
  testIgnore: withoutOwn(base.testIgnore) as typeof base.testIgnore,
  // A base project with a testMatch of its own (the host-fixture ones) would run those specs here, in this
  // config's fixture: none of this config's specs uses the host fixture, so they are left out.
  projects: base.projects
    ?.filter((project) => !project.testMatch)
    .map((project) => ({ ...project, testIgnore: withoutOwn(project.testIgnore) as typeof project.testIgnore })),
  testDir: import.meta.dirname,
  // Their own built-page fixture (PW_BUILT_SPA, the triage record): the main config leaves them out.
  testMatch: [
    'agent-text-entries.spec.ts', 'agent-text-paths.spec.ts', 'agent-text-source.spec.ts', 'agent-text-mail-group.spec.ts',
    'agent-text-referrer.spec.ts', 'agent-status-source.spec.ts', 'agent-thread-source.spec.ts', 'agent-unknown-source.spec.ts',
    'board-kanban-text-source.spec.ts', 'agent-session-writer-source.spec.ts', 'real-press.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  use: {
    ...base.use,
    video: process.env.PW_VIDEO ? { mode: 'on', size: { width: 1280, height: 900 } } : 'off',
  },
  webServer: {
    ...base.webServer,
    cwd: root,
    command: `${bunCommand()} x --cwd web vite build && ${bunCommand()} tests/e2e/browser/test-server.ts`,
  },
})
