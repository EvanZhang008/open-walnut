/**
 * A stand-in Notion workspace for the importer's tests: the read endpoints the importer calls
 * (users/me, search, blocks, databases, data sources, file downloads), with Notion's shapes and
 * pagination, a 429 on demand, and a call log. Used as a fetch stub in unit tests and as an
 * HTTP server (WALNUT_NOTION_API_BASE) for the browser and e2e tests. Invented content only.
 */
import zlib from 'node:zlib'
import http from 'node:http'

/** A secret of Notion's shape for the stand-in workspace, built here so no key-like literal sits in the repo. */
export const fakeSecret = (name: string) => ['ntn', name, 'x'.repeat(24)].join('_')


type Json = Record<string, any>

export interface FakePage {
  id: string
  title: string
  parent: Json
  edited: string
  created: string
  properties?: Json
  blocks: Json[]
  /** Left out of search results, found only as a child_page block. */
  hidden?: boolean
  /** Moved to the trash in Notion. */
  trashed?: boolean
}

let seq = 0
export function fakeId(n?: number): string {
  const hex = (n ?? ++seq).toString(16).padStart(12, '0')
  return `1a2b3c4d-0000-4000-8000-${hex}`
}

const rt = (text: string, extra: Json = {}) => ({ type: 'text', plain_text: text, text: { content: text }, annotations: {}, href: null, ...extra })

export function para(text: string | Json[], extra: Json = {}): Json {
  return { object: 'block', id: fakeId(), type: 'paragraph', has_children: false, paragraph: { rich_text: typeof text === 'string' ? [rt(text)] : text }, ...extra }
}

export const r = rt

export class FakeNotion {
  pages = new Map<string, FakePage>()
  dataSources = new Map<string, { id: string; databaseId: string; title: string; parent: Json; edited: string; created: string; schema: Json }>()
  blockChildren = new Map<string, Json[]>()
  files = new Map<string, { bytes: Uint8Array; type: string }>()
  calls: string[] = []
  rateLimitNext = 0
  token = fakeSecret('testsecret')
  base = 'https://api.notion.com'

  addPage(page: Omit<FakePage, 'created' | 'edited'> & { created?: string; edited?: string }): FakePage {
    const full: FakePage = { created: '2024-01-01T00:00:00.000Z', edited: '2024-02-01T00:00:00.000Z', ...page }
    this.pages.set(full.id, full)
    this.indexBlocks(full.blocks)
    return full
  }

  private indexBlocks(blocks: Json[]): void {
    for (const block of blocks) {
      if (block.children) {
        this.blockChildren.set(block.id, block.children)
        block.has_children = true
        this.indexBlocks(block.children)
      }
    }
  }

  setBlocks(pageId: string, blocks: Json[], edited: string): void {
    const page = this.pages.get(pageId)!
    page.blocks = blocks
    page.edited = edited
    this.indexBlocks(blocks)
  }

  private pageObject(page: FakePage): Json {
    return {
      object: 'page',
      id: page.id,
      url: `https://www.notion.so/${page.title.replace(/\W+/g, '-')}-${page.id.replace(/-/g, '')}`,
      created_time: page.created,
      last_edited_time: page.edited,
      in_trash: !!page.trashed,
      parent: page.parent,
      properties: page.properties ?? { title: { id: 'title', type: 'title', title: [rt(page.title)] } },
    }
  }

  /** Results per page: small on purpose in unit tests, so every caller walks the cursor. */
  pageSize = 2

  private list(results: Json[], cursor: string | undefined, size = this.pageSize): Json {
    const start = cursor ? Number(cursor) : 0
    const slice = results.slice(start, start + size)
    const more = start + size < results.length
    return { object: 'list', results: slice, has_more: more, next_cursor: more ? String(start + size) : null }
  }

  handle(method: string, url: string, body: Json | undefined, auth: string | undefined): { status: number; json?: Json; bytes?: Uint8Array; type?: string; headers?: Record<string, string> } {
    const u = new URL(url, this.base)
    this.calls.push(`${method} ${u.pathname}`)
    if (u.pathname.startsWith('/files/')) {
      const file = this.files.get(u.pathname)
      return file ? { status: 200, bytes: file.bytes, type: file.type } : { status: 404, json: {} }
    }
    if (auth !== `Bearer ${this.token}`) return { status: 401, json: { object: 'error', code: 'unauthorized', message: 'API token is invalid.' } }
    if (this.rateLimitNext > 0) {
      this.rateLimitNext--
      return { status: 429, json: { code: 'rate_limited', message: 'slow down' }, headers: { 'retry-after': '0' } }
    }
    const path = u.pathname
    if (method === 'GET' && path === '/v1/users/me') {
      return { status: 200, json: { object: 'user', id: 'bot', name: 'Walnut import', type: 'bot', bot: { workspace_name: 'Acme notes' } } }
    }
    if (method === 'POST' && path === '/v1/search') {
      const kind = body?.filter?.value
      const cursor = body?.start_cursor
      if (kind === 'data_source') {
        return { status: 200, json: this.list([...this.dataSources.values()].map((ds) => ({
          object: 'data_source', id: ds.id, title: [rt(ds.title)], description: [rt(`About ${ds.title}`)],
          created_time: ds.created, last_edited_time: ds.edited, parent: { type: 'database_id', database_id: ds.databaseId },
          database_parent: ds.parent, properties: ds.schema,
        })), cursor) }
      }
      return { status: 200, json: this.list([...this.pages.values()].filter((p) => !p.hidden).map((p) => this.pageObject(p)), cursor) }
    }
    let m = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path)
    if (method === 'GET' && m) {
      const id = m[1]
      const kids = this.pages.get(id)?.blocks ?? this.blockChildren.get(id)
      if (!kids) return { status: 404, json: { code: 'object_not_found' } }
      return { status: 200, json: this.list(kids.map(({ children, ...rest }) => rest), u.searchParams.get('start_cursor') ?? undefined) }
    }
    m = /^\/v1\/blocks\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      for (const page of this.pages.values()) {
        const found = this.findBlock(page.blocks, m[1], { type: 'page_id', page_id: page.id })
        if (found) return { status: 200, json: found }
      }
      return { status: 404, json: {} }
    }
    m = /^\/v1\/pages\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      const page = this.pages.get(m[1])
      return page ? { status: 200, json: this.pageObject(page) } : { status: 404, json: { code: 'object_not_found' } }
    }
    m = /^\/v1\/databases\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      const sources = [...this.dataSources.values()].filter((ds) => ds.databaseId === m![1])
      if (!sources.length) return { status: 404, json: {} }
      return { status: 200, json: { object: 'database', id: m[1], title: [rt(sources[0].title)], data_sources: sources.map((ds) => ({ id: ds.id, name: ds.title })) } }
    }
    m = /^\/v1\/data_sources\/([^/]+)$/.exec(path)
    if (method === 'GET' && m) {
      const ds = this.dataSources.get(m[1])
      return ds ? { status: 200, json: { object: 'data_source', id: ds.id, title: [rt(ds.title)], properties: ds.schema, parent: { type: 'database_id', database_id: ds.databaseId }, database_parent: ds.parent } } : { status: 404, json: {} }
    }
    m = /^\/v1\/data_sources\/([^/]+)\/query$/.exec(path)
    if (method === 'POST' && m) {
      const rows = [...this.pages.values()].filter((p) => p.parent.data_source_id === m![1])
      return { status: 200, json: this.list(rows.map((p) => this.pageObject(p)), body?.start_cursor) }
    }
    return { status: 400, json: { code: 'invalid_request_url', message: `no ${method} ${path}` } }
  }

  private findBlock(blocks: Json[], id: string, parent: Json): Json | null {
    for (const block of blocks) {
      if (block.id === id) return { ...block, children: undefined, parent }
      if (block.children) {
        const found = this.findBlock(block.children, id, { type: 'block_id', block_id: block.id })
        if (found) return found
      }
    }
    return null
  }

  /** A `fetch` that answers from this workspace. */
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const out = this.handle(init?.method ?? 'GET', url, body, headers.get('authorization') ?? undefined)
    if (out.bytes) return new Response(out.bytes, { status: out.status, headers: { 'content-type': out.type ?? 'application/octet-stream', 'content-length': String(out.bytes.byteLength) } })
    return new Response(JSON.stringify(out.json ?? {}), { status: out.status, headers: { 'content-type': 'application/json', ...(out.headers ?? {}) } })
  }) as typeof fetch

  /** Serve it over HTTP. */
  async listen(port = 0): Promise<{ url: string; close(): Promise<void> }> {
    const server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        const out = this.handle(req.method ?? 'GET', req.url ?? '/', raw ? JSON.parse(raw) : undefined, req.headers.authorization)
        if (out.bytes) {
          res.writeHead(out.status, { 'content-type': out.type ?? 'application/octet-stream', 'content-length': String(out.bytes.byteLength) })
          res.end(Buffer.from(out.bytes))
          return
        }
        res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers ?? {}) })
        // Hosted-file URLs in blocks point at this server, as Notion's point at its own storage.
        res.end(JSON.stringify(out.json ?? {}).replaceAll('https://files.example.test', this.base))
      })
    })
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    this.base = `http://127.0.0.1:${address.port}`
    return { url: this.base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

}

/** A small real picture (160 x 100, a colour gradient), so a look at the imported note shows it. */
export const PNG = makePng(160, 100)
/** A real one-page PDF that says "Quarterly report". */
export const PDF = makePdf('Quarterly report')

function makePng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = Math.round((x / width) * 200) + 40
      raw[row + 2 + x * 3] = Math.round((y / height) * 160) + 60
      raw[row + 3 + x * 3] = 200
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head, data])) >>> 0)
    return Buffer.concat([len, head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

function makePdf(text: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n` })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

/**
 * The standard workspace: a Home page with every block kind, two same-named sub-pages, a page
 * only reachable as a child block, a database with two rows, and a second root.
 */
export function standardWorkspace(): { notion: FakeNotion; ids: Record<string, string> } {
  const notion = new FakeNotion()
  const ids = {
    home: fakeId(1001), childA: fakeId(1002), notes1: fakeId(1003), notes2: fakeId(1004), hidden: fakeId(1005),
    db: fakeId(1006), ds: fakeId(1007), row1: fakeId(1008), row2: fakeId(1009), second: fakeId(1010),
    imageBlock: fakeId(1011), pdfBlock: fakeId(1012), zipBlock: fakeId(1013),
  }
  notion.files.set('/files/photo.png', { bytes: PNG, type: 'image/png' })
  notion.files.set('/files/report.pdf', { bytes: PDF, type: 'application/pdf' })
  notion.files.set('/files/archive.zip', { bytes: new Uint8Array([80, 75, 3, 4]), type: 'application/zip' })
  const file = (name: string) => ({ type: 'file', file: { url: `https://files.example.test/files/${name}?X-Amz-Signature=abc` } })
  notion.addPage({
    id: ids.home, title: 'Home', parent: { type: 'workspace', workspace: true },
    blocks: [
      { object: 'block', id: fakeId(), type: 'heading_1', heading_1: { rich_text: [r('Welcome')] } },
      para([r('Some '), r('bold', { annotations: { bold: true } }), r(' and a '), r('link', { href: 'https://example.com/a b', text: { content: 'link', link: { url: 'https://example.com/a b' } } }), r(' to '), { type: 'mention', plain_text: 'Child A', mention: { type: 'page', page: { id: ids.childA } }, annotations: {} }, r('.')]),
      { object: 'block', id: fakeId(), type: 'bulleted_list_item', bulleted_list_item: { rich_text: [r('Outer')] }, children: [
        { object: 'block', id: fakeId(), type: 'bulleted_list_item', bulleted_list_item: { rich_text: [r('Inner')] } },
      ] },
      { object: 'block', id: fakeId(), type: 'numbered_list_item', numbered_list_item: { rich_text: [r('First')] } },
      { object: 'block', id: fakeId(), type: 'numbered_list_item', numbered_list_item: { rich_text: [r('Second')] } },
      { object: 'block', id: fakeId(), type: 'to_do', to_do: { rich_text: [r('Done thing')], checked: true } },
      { object: 'block', id: fakeId(), type: 'toggle', toggle: { rich_text: [r('Details')] }, children: [para('Hidden text')] },
      { object: 'block', id: fakeId(), type: 'callout', callout: { rich_text: [r('Heads up')], icon: { type: 'emoji', emoji: '💡' }, color: 'yellow_background' } },
      { object: 'block', id: fakeId(), type: 'code', code: { rich_text: [r('const a = 1')], language: 'javascript', caption: [] } },
      { object: 'block', id: fakeId(), type: 'equation', equation: { expression: 'e = mc^2' } },
      para([r('Inline maths: '), { type: 'equation', plain_text: 'a^2 + b^2', equation: { expression: 'a^2 + b^2' }, annotations: {} }, r('.')]),
      { object: 'block', id: fakeId(), type: 'quote', quote: { rich_text: [r('Quoted')] } },
      { object: 'block', id: fakeId(), type: 'divider', divider: {} },
      { object: 'block', id: fakeId(), type: 'table', table: { table_width: 2, has_column_header: true, has_row_header: false }, children: [
        { object: 'block', id: fakeId(), type: 'table_row', table_row: { cells: [[r('Col A')], [r('Col B')]] } },
        { object: 'block', id: fakeId(), type: 'table_row', table_row: { cells: [[r('a|1')], [r('line1\nline2')]] } },
      ] },
      { object: 'block', id: ids.imageBlock, type: 'image', image: { ...file('photo.png'), caption: [r('A photo')] } },
      { object: 'block', id: ids.pdfBlock, type: 'pdf', pdf: { ...file('report.pdf'), caption: [] } },
      { object: 'block', id: ids.zipBlock, type: 'file', file: { ...file('archive.zip'), caption: [], name: 'archive.zip' } },
      { object: 'block', id: fakeId(), type: 'video', video: { type: 'external', external: { url: 'https://video.example.test/v' }, caption: [] } },
      { object: 'block', id: fakeId(), type: 'column_list', column_list: {}, children: [
        { object: 'block', id: fakeId(), type: 'column', column: {}, children: [para('Left column')] },
        { object: 'block', id: fakeId(), type: 'column', column: {}, children: [para('Right column')] },
      ] },
      { object: 'block', id: ids.childA, type: 'child_page', child_page: { title: 'Child A' } },
      { object: 'block', id: ids.notes1, type: 'child_page', child_page: { title: 'Notes' } },
      { object: 'block', id: ids.notes2, type: 'child_page', child_page: { title: 'Notes' } },
      { object: 'block', id: ids.db, type: 'child_database', child_database: { title: 'Tasks' } },
    ],
  })
  notion.addPage({
    id: ids.childA, title: 'Child A', parent: { type: 'page_id', page_id: ids.home }, created: '2024-01-02T00:00:00.000Z',
    blocks: [
      para([r('Back to '), { type: 'mention', plain_text: 'Home', mention: { type: 'page', page: { id: ids.home } }, annotations: {} }]),
      { object: 'block', id: ids.hidden, type: 'child_page', child_page: { title: 'Deep page' }, last_edited_time: '2024-02-03T00:00:00.000Z' },
    ],
  })
  notion.addPage({ id: ids.notes1, title: 'Notes', parent: { type: 'page_id', page_id: ids.home }, created: '2024-01-03T00:00:00.000Z', blocks: [para('First notes')] })
  notion.addPage({ id: ids.notes2, title: 'Notes', parent: { type: 'page_id', page_id: ids.home }, created: '2024-01-04T00:00:00.000Z', blocks: [para('Second notes')] })
  notion.addPage({ id: ids.hidden, title: 'Deep page', parent: { type: 'page_id', page_id: ids.childA }, hidden: true, blocks: [para('Found only by walking')] })
  notion.dataSources.set(ids.ds, {
    id: ids.ds, databaseId: ids.db, title: 'Tasks', parent: { type: 'page_id', page_id: ids.home },
    edited: '2024-02-01T00:00:00.000Z', created: '2024-01-05T00:00:00.000Z',
    schema: { Name: { type: 'title' }, Status: { type: 'select' }, Due: { type: 'date' } },
  })
  const rowProps = (title: string, status: string, related?: string) => ({
    Name: { type: 'title', title: [r(title)] },
    Status: { type: 'select', select: { name: status } },
    Due: { type: 'date', date: { start: '2024-03-01', end: null } },
    Tags: { type: 'multi_select', multi_select: [{ name: 'alpha' }, { name: 'beta' }] },
    Done: { type: 'checkbox', checkbox: status === 'Done' },
    Related: { type: 'relation', relation: related ? [{ id: related }] : [] },
  })
  notion.addPage({ id: ids.row1, title: 'Write report', parent: { type: 'data_source_id', data_source_id: ids.ds, database_id: ids.db }, created: '2024-01-06T00:00:00.000Z', properties: rowProps('Write report', 'Done', ids.row2), blocks: [para('Row body')] })
  notion.addPage({ id: ids.row2, title: 'Plan trip', parent: { type: 'data_source_id', data_source_id: ids.ds, database_id: ids.db }, created: '2024-01-07T00:00:00.000Z', properties: rowProps('Plan trip', 'Todo'), blocks: [] })
  notion.addPage({ id: ids.second, title: 'Second root', parent: { type: 'workspace', workspace: true }, created: '2024-01-08T00:00:00.000Z', blocks: [para('Another tree')] })
  return { notion, ids }
}
