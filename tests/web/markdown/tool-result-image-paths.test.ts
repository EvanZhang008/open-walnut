import { describe, it, expect } from 'vitest';
import { findImagePaths } from '@/utils/markdown';

/**
 * Absolute image paths in tool output must START a token.
 *
 * The bug (2026-09-08, found on a live remote session): the absolute matcher's
 * leading `\/` had no guard, so it matched any slash INSIDE a longer token and read
 * a relative path as an absolute one beginning at its first slash. A
 * `git status --short` line `M repo/team/docs/images/x.png` yielded the invented
 * `/team/docs/images/x.png`, which the chat then rendered as
 * `<img src="/api/local-image?path=…">`: a broken image card plus a 404 on every
 * paint, because no host has that path.
 *
 * The server-side twin of this matcher (src/providers/session-io.ts) had the same
 * defect and did worse with it: it REPLACED the matched span, so the stored text
 * became `repo` + a mirror path. This file pins the browser half; the server half is
 * pinned in tests/providers/session-io-download.test.ts.
 */
describe('findImagePaths (chat/tool-result image detection)', () => {
  it('does not invent an absolute path out of a relative one', () => {
    // The whole relative name is still returned by the relative pass, which is what
    // lets it be resolved against the session cwd.
    expect(findImagePaths(' M repo-part/team/proj/docs/images/onboarding.png'))
      .toEqual(['repo-part/team/proj/docs/images/onboarding.png']);
  });

  it('rejects any slash that continues a token', () => {
    for (const text of ['the file/tmp/dir/a.png', '$HOME/tmp/dir/a.png', './images/dir/a.png']) {
      const abs = findImagePaths(text).filter((p) => p.startsWith('/'));
      expect(abs, text).toEqual([]);
    }
  });

  it('still finds an absolute path after any punctuation prose puts in front of it', () => {
    // The guard is a negative lookbehind, not an allowlist of preceding characters:
    // a markdown-bolded path is ordinary in CLI output, and an allowlist drops every
    // separator nobody thought of.
    for (const text of [
      'at /tmp/charts/a.png done',
      '/tmp/charts/a.png ready',
      '![x](/tmp/charts/a.png)',
      'Saved to **/tmp/charts/a.png**',
      '|/tmp/charts/a.png|',
      'cmd;/tmp/charts/a.png',
      '<img src=/tmp/charts/a.png>',
    ]) {
      expect(findImagePaths(text), text).toContain('/tmp/charts/a.png');
    }
  });

  it('still finds an absolute path with spaces in its segments', () => {
    expect(findImagePaths('see /tmp/My Folder/a shot.png here')).toContain('/tmp/My Folder/a shot.png');
  });
});
