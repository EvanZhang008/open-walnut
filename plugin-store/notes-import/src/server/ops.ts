/**
 * The plugin's ops, for its App and for sessions (the host names them `notes_import_<name>`).
 *
 * Reach: only `status` and `folders` answer from a remote caller. Connecting stores a secret,
 * importing writes many notes, organizing spends the person's AI and moves their notes: each is a
 * click in the App on this Walnut, never a step a session or the phone takes on its own.
 */
import type { PluginOpDefinition, WalnutServerApi } from '@open-walnut/plugin-api/server'
import type { Runtime } from './runtime'

interface OpSpec {
  name: string
  title: string
  description: string
  readonly: boolean
  /** A read that still stays in the App on this Walnut (it uses the Notion secret). */
  local?: boolean
  properties?: Record<string, unknown>
  run(runtime: Runtime, args: Record<string, unknown>): Promise<unknown> | unknown
}

const FOLDER = { type: 'string', description: 'A notes folder, vault-relative (default "Import from Notion")' }

export const OP_SPECS: OpSpec[] = [
  {
    name: 'status', title: 'Import status', readonly: true,
    description: 'Read the Notion connection (workspace, what it can see), the import that runs or ran last (counts, errors), recent runs, and the organize plan. Read-only; never shows the secret.',
    run: (rt) => rt.publicState(),
  },
  {
    name: 'folders', title: 'Notes folders', readonly: true,
    description: 'List the folders of the notes vault, to pick where an import goes. Read-only.',
    run: async (rt) => ({ folders: await rt.folders() }),
  },
  {
    name: 'notion_connect', title: 'Connect Notion', readonly: false,
    description: 'Check a Notion internal connection secret (ntn_…) with Notion, keep it in Walnut\'s secret store, then look at what it can see.',
    properties: { token: { type: 'string', description: 'The connection\'s Internal Integration Secret' } },
    run: (rt, args) => rt.connect(String(args.token ?? '')),
  },
  {
    name: 'notion_disconnect', title: 'Disconnect Notion', readonly: false,
    description: 'Forget the Notion secret. Imported notes stay.',
    run: (rt) => rt.disconnect(),
  },
  {
    name: 'notion_check', title: 'Check Notion access', readonly: false,
    description: 'Look again at what the Notion connection can see (after sharing more pages with it in Notion).',
    // Answers at once; the page shows the check running and its result (a big workspace takes minutes).
    run: (rt) => { void rt.checkAccess(); return rt.publicState() },
  },
  {
    name: 'import_start', title: 'Import from Notion', readonly: false,
    description: 'Import every page the connection can see (or only the chosen top-level pages and what is under them) into a notes folder. A page imported before is updated in place when it changed in Notion, skipped when it did not, and left alone when it was edited in Walnut since. Only reads Notion.',
    properties: {
      folder: FOLDER,
      rootIds: { type: 'array', items: { type: 'string' }, description: 'Top-level Notion page or database ids to import; empty = everything' },
      bringBack: { type: 'array', items: { type: 'string' }, description: 'Notes the person deleted in Walnut (paths from the last import\'s "you deleted" list) to write again' },
      takeNotion: { type: 'array', items: { type: 'string' }, description: 'Notes in the folder, edited in Walnut, that take Notion\'s version anyway; the person\'s version is kept beside each as "<name> (your edit)"' },
    },
    run: (rt, args) => rt.startImport({
      folder: typeof args.folder === 'string' ? args.folder : undefined,
      rootIds: Array.isArray(args.rootIds) ? args.rootIds.map(String) : undefined,
      takeNotion: Array.isArray(args.takeNotion) ? args.takeNotion.map(String) : undefined,
      bringBack: Array.isArray(args.bringBack) ? args.bringBack.map(String) : undefined,
    }),
  },
  {
    name: 'notion_preview', title: 'Compare with Notion', readonly: true, local: true,
    description: 'For an imported note edited in Walnut: its text and Notion\'s version of the page now, side by side. Reads Notion only; writes nothing.',
    properties: { path: { type: 'string', description: 'The note\'s path' } },
    run: (rt, args) => rt.previewNotion(String(args.path ?? '')),
  },
  {
    name: 'import_remove_gone', title: 'Delete notes gone from Notion', readonly: false,
    description: 'Delete notes whose pages are gone from Notion, from the last import\'s list only. Their text is kept until the next import, so import_restore_gone brings them back.',
    properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Note paths from the last import\'s "gone from Notion" list' } },
    run: (rt, args) => rt.removeGone(Array.isArray(args.paths) ? args.paths.map(String) : []),
  },
  {
    name: 'import_restore_gone', title: 'Bring back deleted notes', readonly: false,
    description: 'Bring back the notes import_remove_gone deleted since the last import.',
    run: (rt) => rt.restoreGone(),
  },
  {
    name: 'import_cancel', title: 'Stop the import', readonly: false,
    description: 'Stop the running import. Notes written so far stay; the next import picks up from there.',
    run: (rt) => rt.cancelImport(),
  },
  {
    name: 'organize_plan', title: 'Plan how to organize', readonly: false,
    description: 'Ask the person\'s AI to read an imported folder and propose a plan (moves, merges of duplicates, index pages). Changes nothing; the plan waits for organize_apply.',
    properties: { folder: FOLDER },
    run: (rt, args) => rt.plan(typeof args.folder === 'string' ? args.folder : undefined),
  },
  {
    name: 'organize_cancel', title: 'Drop the plan', readonly: false,
    description: 'Stop a plan being made, or drop the plan waiting for approval.',
    run: (rt) => rt.cancelPlan(),
  },
  {
    name: 'organize_apply', title: 'Apply the plan', readonly: false,
    description: 'Carry out the approved plan, writing each change down first so organize_undo can reverse it, and fix every link to a moved or merged note.',
    properties: {
      leaveOut: { type: 'array', items: { type: 'number' }, description: 'Positions (from 0) of plan steps the person left out' },
      plan: { type: 'string', description: 'The madeAt of the plan the person approved; a newer plan is not applied in its place' },
    },
    run: (rt, args) => rt.apply(Array.isArray(args.leaveOut) ? args.leaveOut.map(Number).filter(Number.isInteger) : [], typeof args.plan === 'string' ? args.plan : undefined),
  },
  {
    name: 'organize_undo', title: 'Undo organize', readonly: false,
    description: 'Reverse the last organize run, newest change first. Notes changed or made after it stay as they are.',
    run: (rt) => rt.undo(),
  },
]

export function registerOps(walnut: WalnutServerApi, runtime: Runtime): void {
  for (const spec of OP_SPECS) {
    const definition: PluginOpDefinition = {
      name: spec.name,
      title: spec.title,
      description: spec.description,
      readonly: spec.readonly,
      remote: spec.readonly && !spec.local ? 'allow' : 'deny',
      inputSchema: { type: 'object', properties: spec.properties ?? {} },
      handler: async (args) => spec.run(runtime, args ?? {}),
    }
    walnut.registry.op(definition)
  }
}
