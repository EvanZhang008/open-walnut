/**
 * The same seven operations, registered in the host's op catalogue.
 *
 * One implementation, two registrations. The tool list is the Personal AI's audience; the op
 * catalogue is everything that calls a capability by name: `walnut.ops.call` from another plugin,
 * an action card, the plugin runtime routes, and `walnut tools call` inside a Walnut-managed
 * session. Handing them separate implementations is how the two drift, so both go through
 * `agent-surface.ts` and both answer with the same wrapped text.
 *
 * The flags, and why each one is what it is:
 *
 * - The four reads are `readonly` AND spell `remote: 'allow'` out rather than inheriting it. Same
 *   value the default would give, written down because it is a decision: a session on a remote
 *   dev host reaches these through `walnut tools call`, and reading your own mail from the machine
 *   you are coding on is the point of the capability. Spelled out, a future change to the default
 *   cannot quietly take it away.
 * - The three writes keep the default (`remote: 'deny'`), so a remote session can read mail but
 *   cannot open a draft. That is the conservative half of a decision worth revisiting: none of the
 *   writes can send, so allowing them would not widen what an agent can DO, only where it can ask
 *   from. Left as it is because this slice's mandate was the reads.
 * - `mail_draft`, `mail_request_send` and `mail_to_task` are WRITES but NOT destructive. Asking is
 *   reversible: a draft is a row the human can edit or throw away, a request is a letter they can
 *   answer Discard, and a task is a row they can delete. Marking them destructive would put a
 *   confirmation in front of the one path whose whole purpose is to produce a human confirmation.
 * - `mail_to_task` is additionally IDEMPOTENT, which is what makes it safe to leave unconfirmed: a
 *   second call cannot produce a second task.
 * - There is no `mail_send`. Sending is executed by the approval path itself (the letter answer,
 *   or the console's own Send under the device credential), so there is no entry point here for a
 *   caller to reach and no token to leak or replay.
 *
 * Known limitation, documented rather than papered over: a standalone `walnut` process and the
 * stdio MCP server cannot see plugin-declared ops until the out-of-process slice lands. That is a
 * reach problem, not a hole, because the approval ledger is server-side and a caller that cannot
 * reach the op cannot reach the ledger either.
 */
import {
  asText,
  MAX_LIST_LIMIT,
  mailDraft,
  mailList,
  mailRead,
  mailRequestSend,
  mailSearch,
  mailThread,
  mailToTask,
  type MailAgentDeps,
} from './agent-surface.js'

/**
 * Structurally the host's `PluginOpDefinition`, restated so this file needs no host import.
 *
 * `name` is LOCAL and the host prefixes it, so `list` here is `mail_list` in the catalogue. The
 * prefix is not spelled out below, because writing it twice is how one of them ends up wrong.
 */
export interface MailOpSpec {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  readonly: boolean
  remote?: 'allow' | 'deny'
  destructive?: boolean
  handler(args: Record<string, unknown>): Promise<string>
}

const ACCOUNT_FIELD = {
  type: 'string',
  description: 'Account id. Omit when there is only one mail account.',
} as const

const MESSAGE_FIELD = {
  type: 'string',
  description: 'The message id from a mail_list or mail_search row.',
} as const

export function createMailOps(deps: MailAgentDeps): MailOpSpec[] {
  return [
    {
      name: 'list',
      title: 'List mail',
      description: 'Cached mail envelopes for one account, newest first, as untrusted data.',
      inputSchema: {
        type: 'object',
        properties: {
          account: ACCOUNT_FIELD,
          mailbox: { type: 'string', description: '"inbox", or a mailbox id.' },
          limit: { type: 'integer', description: `Rows, up to ${MAX_LIST_LIMIT}. Default 20.` },
          before: { type: 'string', description: 'The paging token the previous call handed back.' },
        },
      },
      readonly: true,
      remote: 'allow',
      handler: (args) => asText(() => mailList(deps, args)),
    },
    {
      name: 'search',
      title: 'Search mail',
      description:
        'Search one mail account through the provider when it can, else the local cache. The answer says which.',
      inputSchema: {
        type: 'object',
        properties: {
          account: ACCOUNT_FIELD,
          q: { type: 'string', description: 'What to look for.' },
          limit: { type: 'integer', description: `Rows, up to ${MAX_LIST_LIMIT}. Default 20.` },
        },
        required: ['q'],
      },
      readonly: true,
      remote: 'allow',
      handler: (args) => asText(() => mailSearch(deps, args)),
    },
    {
      name: 'read',
      title: 'Read a message',
      description:
        'One message plus its body, fetched from the mail server on first read. Body and subject come back as untrusted data.',
      inputSchema: {
        type: 'object',
        properties: {
          account: ACCOUNT_FIELD,
          message: MESSAGE_FIELD,
          retry: { type: 'boolean', description: 'Ask again for a body the server already refused.' },
        },
        required: ['message'],
      },
      readonly: true,
      remote: 'allow',
      handler: (args) => asText(() => mailRead(deps, args)),
    },
    {
      name: 'thread',
      title: 'Read a mail thread',
      description: 'The cached messages connected to this one by their reply headers, oldest first.',
      inputSchema: {
        type: 'object',
        properties: { account: ACCOUNT_FIELD, message: MESSAGE_FIELD },
        required: ['message'],
      },
      readonly: true,
      remote: 'allow',
      handler: (args) => asText(() => mailThread(deps, args)),
    },
    {
      name: 'to_task',
      title: 'Make a task from a message',
      description:
        'Turn one message into a Walnut task, recording who sent it, when, and a link back to it. '
        + 'Calling it twice hands back the same task rather than making a second one.',
      inputSchema: {
        type: 'object',
        properties: {
          account: ACCOUNT_FIELD,
          message: MESSAGE_FIELD,
          title: { type: 'string', description: 'The task title. Omit to use the subject.' },
          project: { type: 'string', description: 'Put it in this project. Omit for the Inbox.' },
          note: { type: 'boolean', description: 'Also append the start of the body as a note.' },
        },
        required: ['message'],
      },
      readonly: false,
      destructive: false,
      handler: (args) => asText(() => mailToTask(deps, args)),
    },
    {
      name: 'draft',
      title: 'Draft a mail',
      description:
        'Create or edit a mail draft. It cannot send: a draft is a row the human can read, edit or discard.',
      inputSchema: {
        type: 'object',
        properties: {
          account: ACCOUNT_FIELD,
          draftId: { type: 'string', description: 'Edit this draft instead of creating one.' },
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient addresses.' },
          cc: { type: 'array', items: { type: 'string' }, description: 'Cc addresses.' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'Bcc addresses.' },
          subject: { type: 'string' },
          bodyMarkdown: { type: 'string', description: 'The body, as markdown.' },
          inReplyTo: { type: 'string', description: 'A cached message id to reply to.' },
        },
      },
      readonly: false,
      destructive: false,
      handler: (args) => asText(() => mailDraft(deps, args)),
    },
    {
      name: 'request_send',
      title: 'Ask the human to send a draft',
      description:
        'Send the human a letter showing the exact stored draft. It never sends the mail: only their answer does.',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string', description: 'The draft to ask about.' },
          revision: { type: 'integer', description: 'The revision the draft is at. A mismatch is refused.' },
        },
        required: ['draftId', 'revision'],
      },
      readonly: false,
      destructive: false,
      handler: (args) => asText(() => mailRequestSend(deps, args)),
    },
  ]
}
