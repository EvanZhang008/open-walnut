/**
 * Which writer of the Brief a clicked path belongs to (OrgBrief.tsx). The letter renders once, as
 * before; a rendered link's path is only a key. The trusted answer comes from the shaped raw text:
 * marked's own lexer splits it into blocks, each block goes through the same shared renderer, and
 * a path counts only in a block where that renderer made it a file link. Its writers are the
 * stored spans over the path's places in that block (brief-source.ts briefPathWriters).
 */
import { marked, type Token } from 'marked';
import { briefPathWriters, type BriefWriter } from '@open-walnut/brief-structure';
import type { AgentTextSource } from '@/utils/agent-text-source';

/** Each file path the renderer links, with the raw ranges of the blocks it is linked in. Null when
 *  the lexer's blocks do not lay end to end over the text (then no path has a known writer). */
export function briefPathBlocks(text: string, render: (raw: string) => string): Map<string, Array<[number, number]>> | null {
  let tokens: Token[];
  try {
    tokens = marked.lexer(text);
  } catch {
    return null;
  }
  const out = new Map<string, Array<[number, number]>>();
  let at = 0;
  for (const tok of tokens) {
    const raw = tok.raw ?? '';
    // Offsets are only trusted where the token's raw is the text at that place.
    if (text.slice(at, at + raw.length) !== raw) return null;
    if (tok.type !== 'space' && raw.trim()) {
      const doc = new DOMParser().parseFromString(render(raw), 'text/html');
      const paths = new Set(Array.from(doc.querySelectorAll('a.file-link[data-file-path]'), (a) => a.getAttribute('data-file-path')!));
      for (const path of paths) {
        if (!path) continue;
        const list = out.get(path) ?? [];
        list.push([at, at + raw.length]);
        out.set(path, list);
      }
    }
    at += raw.length;
  }
  return at === text.length ? out : null;
}

/** Every writer of `path` across the blocks it is linked in, or null when any part is unknown to Walnut. */
export function briefPathWritersOf(
  text: string, sources: unknown, blocks: Map<string, Array<[number, number]>> | null, path: string,
): BriefWriter[] | null {
  const ranges = blocks?.get(path);
  if (!ranges?.length) return null;
  const out = new Map<string, BriefWriter>();
  for (const range of ranges) {
    const writers = briefPathWriters(text, sources, path, range);
    if (!writers) return null;
    for (const w of writers) out.set(`${w.by}|${w.sessionId ?? ''}`, w);
  }
  return [...out.values()];
}

/** The machine source a writer names: a person is the primary, a session its own, anything else unknown. */
export function writerTextSource(w: BriefWriter): AgentTextSource {
  if (w.by === 'human') return { host: '__local__' };
  if (w.sessionId) return { sessionId: w.sessionId };
  return { unknownSource: true };
}
