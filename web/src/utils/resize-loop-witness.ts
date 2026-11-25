/**
 * Names the observers behind a "ResizeObserver loop completed with undelivered notifications".
 *
 * The browser raises that error with no file and no stack, so its log line could not say which
 * of the page's many observers changed a box inside its own callback (2026-11-23: 43 in a day in
 * the Mac app, filed as "Other in the unknown chunk"). Every observer the page makes is wrapped:
 * each callback that runs notes what it watches (one short name, at most a few per frame), and
 * the logger adds the notes of the frame the error ended to its line, and of the frame after it:
 * the browser delivers the notifications it left undelivered there, so those are the boxes a
 * callback resized inside its own delivery (2026-11-25: two loops left after the composer fix
 * named only the observers that ran, a dozen layout boxes). Only names are kept: a
 * tag, up to two classes and a test id, never text. (tests/e2e/browser/resize-observer-culprits.ts
 * names boxes the same way inside an init script, which cannot import this.)
 */

let frame: string[] = [];
let tickArmed = false;

function nameOf(el: Element | undefined): string {
  if (!el) return '?';
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
  const id = el.getAttribute('data-testid');
  return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${id ? `[${id}]` : ''}`.slice(0, 80);
}

function armTick(): void {
  if (tickArmed) return;
  tickArmed = true;
  // A frame's animation callbacks run before its observers, so a note made after this frame's
  // tick belongs to this frame.
  requestAnimationFrame(() => { tickArmed = false; frame = []; });
}

/** The observers whose callbacks ran in this frame, in order, each once. */
export function resizeLoopWitness(): string {
  return [...new Set(frame)].slice(0, 12).join(', ');
}

/** Runs `then` once the next frame's observers have run, with their notes. */
export function afterNextFrame(then: (next: string) => void): void {
  // The next frame's animation callbacks run first (this one after the tick that clears the
  // notes), then its observers; a task queued from here runs after that frame is drawn.
  requestAnimationFrame(() => { setTimeout(() => then(resizeLoopWitness()), 0); });
}

export function installResizeLoopWitness(): void {
  const Native = typeof window !== 'undefined' ? window.ResizeObserver : undefined;
  if (!Native || (Native as unknown as { __walnutWitness?: boolean }).__walnutWitness) return;
  class Witnessed extends Native {
    static __walnutWitness = true;
    constructor(cb: ResizeObserverCallback) {
      super((entries, ro) => {
        for (const e of entries) if (frame.length < 32) frame.push(nameOf(e.target));
        armTick();
        // As the native observer calls it: `this` is the observer.
        cb.call(ro, entries, ro);
      });
    }
  }
  window.ResizeObserver = Witnessed;
}
