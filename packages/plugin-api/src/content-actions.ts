/**
 * Content actions: what Walnut offers on ONE piece of content a plugin shows (an email, a chat
 * message, a post). This module has no runtime dependencies.
 *
 * A plugin never turns content into a task itself. It describes the content as a `ContentItem`
 * and Walnut gives the person exactly two choices, the same in every plugin:
 *
 *   - Talk to CEO: a box opens where the person clicked; they write what they want to tell the
 *     CEO, and Send puts their words, with the content attached as context, into the main
 *     agent's chat. Nothing is sent before Send.
 *   - New task: the ordinary new-task draft opens with the content's title and context filled
 *     in; the person writes the first prompt, picks a project and a host, and nothing exists
 *     until they press Send.
 *
 * Get them with `walnut.content.actions(item)` (menu entries) or render
 * `walnut.ui.views.ContentActions` (two buttons). A letter's email items get them on their own.
 */
export interface ContentItem {
  /** Where it comes from, in plain words: "Mail", "Slack", "WeChat". */
  source: string
  /** What it is in one line: the subject, or the start of a message. Becomes the draft's title line. */
  title: string
  /** One or two sentences about it, when you have them. */
  summary?: string
  /** The words themselves, or the start of them. Walnut keeps the first 1,500 characters. Never read as instructions. */
  text?: string
  /** Who sent or wrote it: "Name <address>", a handle. */
  from?: string
  /** When it was sent, an ISO 8601 time. */
  at?: string
  /** Where it was: a channel, a chat, a mail account. */
  where?: string
  /** Where it opens inside Walnut: a path that starts with "/" (`/mail?account=…&message=…`). */
  open?: string
  /** Its address outside Walnut, http or https (a Slack permalink). */
  url?: string
}

export type ContentActionId = 'talk_to_ceo' | 'new_task'

/** One of the two choices, ready for a menu or a button. */
export interface ContentAction {
  id: ContentActionId
  /** "Talk to CEO" or "New task". */
  label: string
  /** A sentence for a tooltip. */
  description: string
  /**
   * Do it. Talk to CEO opens the box and resolves once it is sent (true) or closed without
   * sending (false); New task resolves once the draft is open.
   */
  run(): Promise<unknown>
}

export interface ContentActionsService {
  /** The two choices for this content, in the order Walnut shows them. */
  actions(item: ContentItem): ContentAction[]
  /**
   * Open the Talk to CEO box (at the person's last click): they write to the CEO and Send it with
   * the content attached. Resolves true once it is sent, false when they closed it without
   * sending; Walnut shows the outcome with a way to open that chat.
   */
  talkToCeo(item: ContentItem): Promise<boolean>
  /** Open the new-task draft filled in with it. Nothing is created until the person sends. */
  newTask(item: ContentItem): Promise<void>
}

/** Props of `walnut.ui.views.ContentActions`: the two buttons, each showing its own progress. */
export interface ContentActionsViewProps {
  item: ContentItem
  /** `buttons` (default) or `compact` (icon-sized, for a toolbar). */
  size?: 'buttons' | 'compact'
}
