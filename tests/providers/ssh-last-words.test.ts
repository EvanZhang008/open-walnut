import { describe, it, expect } from 'vitest'
import { lastWordsExcerpt } from '../../src/providers/ssh-last-words.js'

describe('lastWordsExcerpt', () => {
  it('keeps short words whole', () => {
    expect(lastWordsExcerpt('  client_loop: send disconnect: Broken pipe\n')).toBe('client_loop: send disconnect: Broken pipe')
  })

  it('keeps the head, the error line and the tail of a long stack', () => {
    const stack = ['/usr/local/bin/relay:1234', '      throw err;', '      ^', '', 'Error [ERR_STREAM_PUSH_AFTER_EOF]: stream.push() after EOF']
      .concat(Array.from({ length: 40 }, (_, i) => `    at frame${i} (node:internal/streams/readable:${i}:9)`))
      .concat(['', 'Node.js v18.20.8', 'Connection to host closed by remote host.', 'client_loop: send disconnect: Broken pipe'])
      .join('\n')
    const out = lastWordsExcerpt(stack)
    expect(out.length).toBeLessThan(1000)
    expect(out).toContain('/usr/local/bin/relay:1234')
    expect(out).toContain('Error [ERR_STREAM_PUSH_AFTER_EOF]: stream.push() after EOF')
    expect(out).toContain('Broken pipe')
  })
})
