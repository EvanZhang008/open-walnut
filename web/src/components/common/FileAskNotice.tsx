/**
 * Why an Ask here opened no card (FILE_ASK_FAILURE_TEXT), in the Files tab and the Changed
 * tab: a pressed Ask here never does nothing. It shows in the notice corner like every
 * notice Walnut raises itself (tests/web/corner-stack-guard.test.ts).
 */
import { CornerSlot, CORNER_ORDER } from '@/components/common/corner-stack';

export function FileAskNotice({ text }: { text: string }) {
  return (
    <CornerSlot order={CORNER_ORDER.fileAsk} className="corner-slot-file-ask">
      <div className="fv-ask-notice" role="status" data-testid="file-ask-notice">{text}</div>
    </CornerSlot>
  );
}
