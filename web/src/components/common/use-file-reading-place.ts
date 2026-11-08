/**
 * The reader's place in a file view, kept across every way the view goes and comes back:
 * a Preview/Source switch, a close and reopen of Files, a reload (2026-11-11 WebKit review:
 * Preview at Section 7, about line 281, switched to Source showed line 1; Source left near
 * line 10, closed and reopened, showed line 237).
 *
 * The place is noted on every scroll as the source line at the top of the view, beside the
 * pixel offset and the view it was measured in (utils/file-view-state.ts). A switch notes the
 * outgoing view's line at the press and brings the incoming view to it; a reopen brings the
 * view on show to the saved line (a pixel offset only into the view it was measured in, for
 * the HTML page, which cannot name a line). The incoming body mounts on its own frames (the
 * editors fill after mount, CodeMirror measures heights as it draws, images load), so the
 * place is CHASED across frames and then held until the reader takes over (a wheel, a key, a
 * press) or 5 s pass.
 *
 * A width change is the other keeper's (utils/reading-place.ts), which holds the same place
 * while the text rewraps.
 */
import { useCallback, useEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import { loadFileScroll, placeForView, saveFileScroll, type FileViewKind } from '@/utils/file-view-state';
import { lineSurfaceOf, readTopLine, stepToLine, stepToTop, type PlaceStep } from '@/utils/reading-line-dom';

/** The last place OBSERVED while a view was live: the unmount flush uses it, because by
 *  teardown the node is detached and reads `scrollTop` 0. The HTML page reports its own. */
export interface ReadingSeen { key: string; top: number; line?: number; topIn?: FileViewKind }

const CHASE_MS = 5000;

/** A place being brought back: a line or a pixel offset, into any view but `from` (the one a
 *  switch is leaving, still mounted for a frame). */
interface Chase { key: string; line?: number; top: number; topIn?: FileViewKind; from?: FileViewKind; until: number }

export interface ReadingPlaceOptions {
  rootRef: RefObject<HTMLElement | null>;
  host: string | undefined;
  filePath: string;
  /** The view shows text (loaded, not media): there is a place to keep. */
  active: boolean;
  /** Changes when the content does (a read landed): the chase looks again. */
  contentNonce: unknown;
  /** A deep link to a line owns the scroll: no saved place is restored. */
  line: number | undefined;
  /** The source text the view shows (a carried draft, else the file). */
  textOf: () => string;
  /** The Source/Preview choice to store with the place. */
  sourceChosen: () => boolean;
  seenRef: MutableRefObject<ReadingSeen | null>;
}

export function useFileReadingPlace(o: ReadingPlaceOptions): { noteSwitch: (toSource: boolean) => void } {
  const { rootRef, host, filePath, active, contentNonce, line, seenRef } = o;
  const key = `${host ?? 'local'} ${filePath}`;
  const textRef = useRef(o.textOf);
  textRef.current = o.textOf;
  const chosenRef = useRef(o.sourceChosen);
  chosenRef.current = o.sourceChosen;
  const chaseRef = useRef<Chase | null>(null);
  const restoredForRef = useRef<string | null>(null);
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active) return;
    // Restored once per FILE: a reload or a switch re-runs this and only re-attaches.
    if (restoredForRef.current !== key) {
      restoredForRef.current = key;
      const saved = line ? null : loadFileScroll(host, filePath);
      chaseRef.current = saved && (saved.line !== undefined || saved.top > 0)
        ? { key, line: saved.line, top: saved.top, topIn: saved.topIn, until: Date.now() + CHASE_MS } : null;
    }
    const persist = () => {
      const seen = seenRef.current;
      if (seen?.key === key) saveFileScroll(host, filePath, { top: seen.top, line: seen.line, topIn: seen.topIn, source: chosenRef.current() });
    };
    // The HTML preview has no line surface: its frame keeps its own place (usePreviewFrame),
    // and nothing here walks up to the explorer's pane and scrolls that instead (2026-11-12).
    const noteNow = () => {
      const s = lineSurfaceOf(rootRef.current);
      if (s) seenRef.current = { key, top: s.scroller.scrollTop, line: readTopLine(s, textRef.current()), topIn: s.kind };
    };

    let raf = 0;
    let hold: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      raf = 0;
      hold = undefined;
      const c = chaseRef.current;
      if (!c || c.key !== key) return;
      if (Date.now() > c.until) { chaseRef.current = null; noteNow(); return; }
      const s = lineSurfaceOf(rootRef.current);
      if (s && s.kind !== c.from) {
        const place = placeForView(c, s.kind);
        if (!place) { chaseRef.current = null; noteNow(); return; }
        const step: PlaceStep = 'line' in place ? stepToLine(s, textRef.current(), place.line) : stepToTop(s.scroller, place.top);
        // Until it holds, the place being restored is the reader's (a close now keeps it).
        seenRef.current = { key, top: s.scroller.scrollTop, line: c.line, topIn: s.kind };
        // There: held for the rest of the chase, looked at less often, because the text above
        // can still grow (an image loading, the editor measuring lines it had only estimated).
        if (step === 'done') { hold = setTimeout(tick, 150); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    kickRef.current = () => {
      if (hold) { clearTimeout(hold); hold = undefined; }
      if (!raf) raf = requestAnimationFrame(tick);
    };
    if (chaseRef.current?.key === key) kickRef.current();

    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let noteRaf = 0;
    const related = (t: EventTarget | null) => {
      const root = rootRef.current;
      return !!root && t instanceof Node && (root.contains(t) || t.contains(root));
    };
    // Capture on the document, not a listener on one node: the bodies mount on their own
    // frames, and scroll events do not bubble but do capture.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !related(t) || t.scrollHeight <= t.clientHeight + 1) return;
      // A restore's own steps are not the reader's place.
      if (chaseRef.current?.key === key) return;
      if (!noteRaf) noteRaf = requestAnimationFrame(() => {
        noteRaf = 0;
        noteNow();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(persist, 250);
      });
    };
    // The reader takes over: the chase stops and never fights them. Anywhere in the page: a
    // press elsewhere (a question in the chat, the find bar) may move the file on purpose.
    const takeOver = () => { if (chaseRef.current?.key === key) chaseRef.current = null; };
    const inputs = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    for (const ev of inputs) document.addEventListener(ev, takeOver, { capture: true, passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(hold);
      if (noteRaf) cancelAnimationFrame(noteRaf);
      clearTimeout(saveTimer);
      kickRef.current = () => {};
      document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      for (const ev of inputs) document.removeEventListener(ev, takeOver, { capture: true } as EventListenerOptions);
      // Closing the panel is the most common way to leave a file: the last place is kept.
      persist();
    };
  }, [active, key, host, filePath, line, contentNonce, rootRef, seenRef]);

  /** A Preview/Source switch, at the press (the outgoing view is still on show): its line goes
   *  with the reader into the incoming view. */
  const noteSwitch = useCallback((toSource: boolean) => {
    const s = lineSurfaceOf(rootRef.current);
    const seen = seenRef.current?.key === key ? seenRef.current : null;
    let lineNow: number | undefined;
    let from: FileViewKind = 'html';
    if (s) {
      lineNow = readTopLine(s, textRef.current());
      from = s.kind;
      seenRef.current = { key, top: s.scroller.scrollTop, line: lineNow, topIn: s.kind };
    }
    const top = s ? s.scroller.scrollTop : seen?.top ?? 0;
    const topIn = s ? s.kind : seen?.topIn;
    saveFileScroll(host, filePath, { top, line: lineNow, topIn, source: toSource });
    chaseRef.current = lineNow !== undefined ? { key, line: lineNow, top, topIn, from, until: Date.now() + CHASE_MS } : null;
    kickRef.current();
  }, [rootRef, seenRef, key, host, filePath]);

  return { noteSwitch };
}
