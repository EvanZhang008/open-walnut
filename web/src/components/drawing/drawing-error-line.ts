/**
 * The drawing's own error line (DrawingWorkspace's notice line) and what its × is keyed by
 * (utils/notice-dismiss.ts useNoticeDismiss). Pure, tested in tests/web/notice-close-review-fixes.test.ts.
 */
import type { DrawingSnapshot } from './drawing-sync-types';

type Facts = Pick<DrawingSnapshot, 'state' | 'error' | 'conflict' | 'unsaved'>;

/**
 * The error the line shows for the drawing on screen: its words; null once it is known to say
 * nothing (that forgets a close, so the same error coming back later shows); undefined while it is
 * not known yet. `shown` is the snapshot of the drawing picked now (null in the render that
 * switches drawings, never the previous one's), and a loading snapshot knows nothing yet: a close
 * made on a drawing whose load keeps failing stays closed through a reopen or a reload.
 */
export function drawingErrorWords(shown: Facts | null): string | null | undefined {
  if (!shown || shown.state === 'loading') return undefined;
  // A conflict shows its own card, and an unsaved missing or unreadable drawing its own line.
  if (!shown.error || shown.conflict || ((shown.state === 'missing' || shown.state === 'error') && shown.unsaved)) return null;
  return shown.error;
}
