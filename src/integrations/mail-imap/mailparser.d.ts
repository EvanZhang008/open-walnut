/**
 * Local typings for `mailparser`, covering exactly the surface this provider uses.
 *
 * Why not `@types/mailparser`: it tracks the 3.4 line while the pinned runtime is 3.9, so it
 * is one more package to justify AND a shape that can drift from the code actually running.
 * Declaring the two fields and one function we call is smaller, honest about our usage, and
 * fails loudly here if the library ever changes them.
 *
 * `html` really is `string | false`: mailparser returns `false`, not `undefined`, for a message
 * with no HTML part, and a truthiness check that assumed `undefined` would still be correct
 * while a `!== undefined` check would silently treat `false` as HTML.
 *
 * `headerLines` rather than `headers`, for the `List-*` headers: `headers` is a Map holding
 * mailparser's own STRUCTURED reading of a curated header set, and every `List-*` header is folded
 * into one `list` entry that keeps a single url and a single mail address. `headerLines` is the raw
 * record, one entry per header line, `key` lowercased and `line` still folded.
 */
declare module 'mailparser' {
  interface ParsedAttachment {
    filename?: string
    contentType?: string
    size?: number
    contentId?: string
    cid?: string
    partId?: string
    related?: boolean
  }

  interface ParsedHeaderLine {
    /** Lowercased header name. */
    key: string
    /** The whole line, name and value, folding continuations included. */
    line: string
  }

  interface ParsedMail {
    text?: string
    html: string | false
    textAsHtml?: string
    subject?: string
    attachments: ParsedAttachment[]
    headerLines: ParsedHeaderLine[]
  }

  function simpleParser(
    source: Buffer | string,
    options?: { skipHtmlToText?: boolean; skipTextToHtml?: boolean; skipImageLinks?: boolean },
  ): Promise<ParsedMail>
}
