import { markdownToRichHtml } from '@/utils/markdown';
// Shared with the right-click "Copy as rich text" item (components/common/ContextMenu
// call sites) so both paths degrade the same way when the rich write is refused.
import { copyRichText, copyTextRobust } from '@/utils/clipboard';
import { CopyButton } from './CopyButton';

interface CopyMessageButtonsProps {
  /** Raw markdown source of the message (the on-screen text). */
  markdown: string;
}

async function writeMarkdown(markdown: string): Promise<void> {
  if (await copyTextRobust(markdown) === 'failed') throw new Error('copy markdown failed');
}

async function writeRich(markdown: string): Promise<void> {
  if (await copyRichText(markdownToRichHtml(markdown), markdown) === 'failed') throw new Error('copy rich text failed');
}

/**
 * Two small copy actions for a chat message: copy the raw Markdown, or copy as
 * rich text (formatted HTML) for pasting into Docs/Word/email. Each is the shared
 * Copy button (CopyButton.tsx), a quiet key that says Copied for a moment.
 */
export function CopyMessageButtons({ markdown }: CopyMessageButtonsProps) {
  return (
    <span className="msg-copy-actions">
      <CopyButton text={markdown} label="MD" kind="ghost" icon keepLabel isolate write={writeMarkdown}
        className="msg-copy-btn" title="Copy as Markdown" aria-label="Copy as Markdown" />
      <CopyButton text={markdown} label="Rich" kind="ghost" icon keepLabel isolate write={writeRich}
        className="msg-copy-btn" title="Copy as rich text (formatted: paste into Docs, Word, email)" aria-label="Copy as rich text" />
    </span>
  );
}
