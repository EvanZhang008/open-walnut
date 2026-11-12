import { useEffect, useRef } from 'react';
import {
  AUTO_NAME_SETTLE_MS, autoNameFailedBefore, autoNameTarget, isAutoNamed, noteAutoNameFailed,
} from '@/components/notes/note-auto-name';

/** 'busy' answers in a row (a save kept landing) before waiting for the next save. */
const MAX_BUSY_TRIES = 10;

/** The last save THIS editor made (useNoteContent's `ownSave`): its note and a count. */
export interface OwnSave { path: string; seq: number }

/**
 * Keep an auto-named note's file name on its title (components/notes/note-auto-name.ts).
 * Only this editor's own save starts a rename: `ownSave` changes when it wrote the note,
 * never when another writer's bytes came in (the AI in the notes chat, another window),
 * since that writer still holds the note's path and its next write would make the old name
 * again (useNoteContent forgets the auto-naming then). AUTO_NAME_SETTLE_MS after the save,
 * if the saved title (`body`) asks for another name, `rename` moves the note there in place
 * (useNoteContent.renameOpenNote). A move refused because the name is taken (409) is not
 * tried again for that name; any other failure is tried again after the next save.
 */
export function useNoteAutoName(opts: {
  path: string | null;
  /** The open note's saved body (useNoteContent's `content`). */
  body: string | null;
  ownSave: OwnSave | null;
  /** Every file path in the vault tree, for the free-name check. */
  existing: Set<string>;
  rename: (from: string, to: string) => Promise<'moved' | 'busy'>;
  onFailed: (from: string, to: string, err: unknown) => void;
}): void {
  const latest = useRef(opts);
  latest.current = opts;
  const { path, ownSave, existing } = opts;
  useEffect(() => {
    if (!path || ownSave?.path !== path || !isAutoNamed(path)) return;
    let stopped = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const attempt = async () => {
      timer = null;
      const body = latest.current.body;
      if (stopped || !isAutoNamed(path) || body == null) return;
      const target = autoNameTarget(path, body, latest.current.existing);
      if (!target || autoNameFailedBefore(path, target)) return;
      try {
        const result = await latest.current.rename(path, target);
        if (result === 'busy' && !stopped && ++tries < MAX_BUSY_TRIES) timer = setTimeout(attempt, AUTO_NAME_SETTLE_MS);
      } catch (err) {
        if ((err as { status?: unknown } | null)?.status === 409) noteAutoNameFailed(path, target);
        latest.current.onFailed(path, target, err);
      }
    };
    timer = setTimeout(attempt, AUTO_NAME_SETTLE_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [path, ownSave, existing]);
}
