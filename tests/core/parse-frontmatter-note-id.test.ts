/**
 * withNoteId: the id a note write carries (IMPL-CONTRACT §1.2 #3).
 *
 * Both note write routes (notes-v2 PUT, the /api/v1 write path) use it. A body
 * saved without its frontmatter used to get a NEW id on every save, which
 * re-identified the note and orphaned the id-keyed links pointing at it.
 */
import { describe, it, expect } from 'vitest';
import { withNoteId, stampId } from '../../src/core/parse-frontmatter.js';

describe('withNoteId', () => {
  it('writes content that carries an id as sent', () => {
    const content = '---\nid: n_mine\ntitle: Keep\n---\n# Body';
    expect(withNoteId(content, '---\nid: n_other\n---\nold')).toEqual({ content, id: 'n_mine' });
  });

  it('keeps the id of the note on disk when the body has none', () => {
    const result = withNoteId('# Updated', '---\nid: n_ondisk\n---\n# Old');
    expect(result).toEqual({ content: stampId('# Updated', 'n_ondisk'), id: 'n_ondisk' });
  });

  it('keeps the on-disk id beside frontmatter the body brings without one', () => {
    const result = withNoteId('---\ntitle: T\n---\nbody', '---\nid: n_ondisk\n---\nold');
    expect(result.id).toBe('n_ondisk');
    expect(result.content).toBe('---\nid: n_ondisk\ntitle: T\n---\nbody');
  });

  it('mints a new id for a create, or for a note on disk that has none', () => {
    for (const current of [null, '# no frontmatter', '---\ntitle: T\n---\nbody']) {
      const result = withNoteId('# New', current);
      expect(result.id).toMatch(/^n_/);
      expect(result.content).toBe(stampId('# New', result.id));
    }
  });
});
