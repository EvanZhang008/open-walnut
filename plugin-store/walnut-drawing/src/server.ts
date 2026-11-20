import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PluginOpDefinition, WalnutServerApi } from '@open-walnut/plugin-api/server'

const contextProperties = {
  taskId: { type: 'string', description: 'The task whose project and task folder should hold the drawing' },
  sessionId: { type: 'string', description: 'Resolve the task from this session when taskId is absent' },
}
const pathProperty = { type: 'string', description: 'The relative .excalidraw path returned by Drawing' }
const revisionProperty = { type: 'string', description: 'The exact revision returned by the last read; stale writes are refused' }

export function activate(walnut: WalnutServerApi): void {
  walnut.registry.skill({ id: 'drawing', directory: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills') })
  const ops: PluginOpDefinition[] = [
    {
      name: 'list', title: 'List drawings', readonly: true, remote: 'allow',
      description: 'List editable drawings in the Notes vault, optionally belonging to a task or session. Read-only.',
      inputSchema: { type: 'object', properties: contextProperties, additionalProperties: false },
      handler: (args, ctx) => {
        const query = new URLSearchParams()
        for (const key of ['taskId', 'sessionId']) if (typeof args[key] === 'string') query.set(key, args[key])
        return ctx.call('GET', `/api/drawings?${query}`)
      },
    },
    {
      name: 'read', title: 'Read a drawing', readonly: true, remote: 'allow',
      description: 'Read an editable drawing, its scene elements and its current revision. Read before appending; the scene contains positions, shape types, text and arrow connections.',
      inputSchema: { type: 'object', properties: { path: pathProperty }, required: ['path'], additionalProperties: false },
      handler: async (args, ctx) => {
        const path = encodeURIComponent(String(args.path ?? ''))
        const doc = await ctx.call('GET', `/api/drawings/file?path=${path}`)
        // A drawing with recorded walkthroughs answers with their overview (coarse, one line per part).
        try {
          const told = await ctx.call('GET', `/api/drawings/narration?path=${path}`) as { takes?: number; overview?: string }
          if (told?.takes && told.overview && doc && typeof doc === 'object') return { ...(doc as Record<string, unknown>), walkthroughs: told.overview }
        } catch { /* no walkthroughs to tell */ }
        return doc
      },
    },
    {
      name: 'narration', title: 'Read what was said while drawing', readonly: true, remote: 'allow',
      description: 'A drawing\'s recorded walkthroughs: what the person said while drawing, each sentence lined up with the elements they drew, selected or pointed at then. With only path: the overview, one line per part (time span, element, gist), the same that walnut_drawing_read shows. With take and part (numbers from the overview), or from/to in seconds: that part in detail, each sentence with its times, the elements it was matched to and why, and every draw, change, selection and pointer rest in that span. Use it to answer which element the person meant ("the core table"). Read-only.',
      inputSchema: {
        type: 'object', properties: {
          path: pathProperty,
          take: { type: 'integer', minimum: 1, description: 'The take number from the overview (default: the newest)' },
          part: { type: 'integer', minimum: 1, description: 'The part number from the overview' },
          from: { type: 'number', minimum: 0, description: 'Start of a span, seconds from the start of the take' },
          to: { type: 'number', minimum: 0, description: 'End of a span, seconds from the start of the take' },
        }, required: ['path'], additionalProperties: false,
      },
      handler: (args, ctx) => {
        const query = new URLSearchParams({ path: String(args.path ?? '') })
        for (const key of ['take', 'part', 'from', 'to']) if (typeof args[key] === 'number') query.set(key, String(args[key]))
        return ctx.call('GET', `/api/drawings/narration?${query}`)
      },
    },
    {
      name: 'create', title: 'Create a drawing', readonly: false, remote: 'allow',
      description: 'Create an empty editable drawing in the Notes vault. A task or session places it in its project and task folder; otherwise it goes to Inbox. Give it a clear title; without one it is named after the task (or the date). Returns its path, scene and revision.',
      inputSchema: { type: 'object', properties: { ...contextProperties, title: { type: 'string', description: 'The drawing title: a few words that say what it shows' } }, additionalProperties: false },
      handler: (args, ctx) => ctx.call('POST', '/api/drawings', args),
    },
    {
      name: 'append', title: 'Add to a drawing', readonly: false, remote: 'allow',
      description: 'Append shapes without removing or replacing existing elements. Read the drawing first and send its exact revision. Use rectangle, ellipse, diamond, text, arrow, line or freedraw with x/y, width/height for shapes, text for labels, or relative points for lines. Drawing fills in scene defaults and gives additions new ids. A stale revision is refused: read again and reconsider the addition. Never retry by overwriting the full scene.',
      inputSchema: {
        type: 'object', properties: {
          path: pathProperty, revision: revisionProperty,
          elements: { type: 'array', minItems: 1, items: { type: 'object' }, description: 'Shape descriptions or complete scene elements; additions cannot replace existing ids' },
        }, required: ['path', 'revision', 'elements'], additionalProperties: false,
      },
      handler: (args, ctx) => ctx.call('POST', '/api/drawings/append', args),
    },
    {
      name: 'render', title: 'See a drawing', readonly: true, remote: 'allow',
      description: 'Render the drawing to an image file and return its absolute path, so you can look at it with your file reading tool. Use it to see a hand drawing before you tidy it, and again after an edit to check the result.',
      inputSchema: {
        type: 'object', properties: {
          path: pathProperty,
          format: { type: 'string', enum: ['png', 'svg'], description: 'png (default) to look at it, svg for the vector text' },
        }, required: ['path'], additionalProperties: false,
      },
      handler: (args, ctx) => {
        const query = new URLSearchParams({ path: String(args.path ?? '') })
        if (args.format === 'png' || args.format === 'svg') query.set('format', args.format)
        return ctx.call('GET', `/api/drawings/render?${query}`)
      },
    },
    {
      name: 'update', title: 'Edit a drawing', readonly: false, remote: 'allow',
      description: 'Change a drawing in one checked step: edit existing elements by id (text, position, size, colours, points), remove elements by id, and add new ones. Use it to fix text, move things, or turn hand-drawn strokes into a clean diagram (remove the strokes, add labelled shapes and bound arrows). Read the drawing first and send its exact revision; a stale revision is refused, so read again and redo the edit. Additions may carry a temporary id, and arrows may name start and end ids (temporary or existing) to connect shapes; the answer maps temporary ids to real ones. Element ids and types cannot change: remove and add instead.',
      inputSchema: {
        type: 'object', properties: {
          path: pathProperty, revision: revisionProperty,
          update: { type: 'array', items: { type: 'object' }, description: 'Patches: {id, ...fields to change}, for example {id, text} or {id, x, y}' },
          remove: { type: 'array', items: { type: 'string' }, description: 'Ids of elements to delete; their bindings and labels are cleaned up' },
          add: { type: 'array', items: { type: 'object' }, description: 'New shapes as in append, optionally with a temporary id; arrows may use start:{id} and end:{id}' },
        }, required: ['path', 'revision'], additionalProperties: false,
      },
      handler: (args, ctx) => ctx.call('POST', '/api/drawings/update', args),
    },
    {
      name: 'rename', title: 'Rename a drawing', readonly: false, remote: 'allow',
      description: 'Give a drawing a clear title. It stays in its folder (a taken name gets a number), its Notes entry follows, and the answer has its new path: use that path from now on. Send the exact revision from your last read; a stale revision is refused.',
      inputSchema: {
        type: 'object', properties: {
          path: pathProperty, revision: revisionProperty,
          title: { type: 'string', description: 'The new title, a few words that say what the drawing shows' },
        }, required: ['path', 'revision', 'title'], additionalProperties: false,
      },
      handler: (args, ctx) => ctx.call('POST', '/api/drawings/rename', args),
    },
  ]
  for (const op of ops) walnut.registry.op(op)
}
