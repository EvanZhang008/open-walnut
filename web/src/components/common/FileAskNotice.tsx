/**
 * Why an Ask here opened no card (FILE_ASK_FAILURE_TEXT), in the Files tab and the Changed
 * tab: a pressed Ask here never does nothing. It shows in the notice corner like every
 * notice Walnut raises itself (tests/web/corner-stack-guard.test.ts).
 */
import { CornerSlot, CORNER_ORDER } from '@/components/common/corner-stack';
import { NoticeCard } from '@/components/common/NoticeCard';
import { ICON_INFO } from '@/components/common/Icons';

export function FileAskNotice({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <CornerSlot order={CORNER_ORDER.fileAsk} className="corner-slot-file-ask">
      <NoticeCard className="fv-ask-notice" role="status" testId="file-ask-notice" avatar={{ glyph: ICON_INFO, tone: 'warn' }} who="Ask here" status={{ tone: 'warn', text: 'No card opened' }} onClose={onClose}>
        {/* Whole, never cut: it says why the press did nothing. */}
        <div className="fv-ask-notice-text">{text}</div>
      </NoticeCard>
    </CornerSlot>
  );
}
