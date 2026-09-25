/**
 * Mail's side of the Ask-Walnut drawer: the store's `ask` turned into `AskObjectDrawer` props.
 *
 * A thin adapter on purpose. Everything reusable (the session per object, the single flight, the
 * context block on the first question, the preset send, Escape and the focus return) lives in
 * `AskObjectDrawer`; everything mail-shaped (the block, the quote, the key) lives in the pure
 * `mail-ask.ts`. What is left here is which agent answers and how the drawer is closed, which is the
 * only part a second surface could not share.
 *
 * `general` is the agent: this is the console's own Walnut, the same one the Ask Walnut slot talks to,
 * so a question about a mail lands in the assistant the person already knows rather than in a mail
 * specialist they have never met.
 */
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer';
import type { MailAccountDto } from '@/api/mail';
import { mailAskKey, mailAskQuote, mailContextBlock, mailRowSelector } from './mail-ask';
import { closeMailAsk, type MailAsk } from './mail-store';

/** The agent that answers. Named here, once, so no caller can drift to another one. */
export const MAIL_ASK_AGENT = 'general';

/** `Name <address>`, or whichever half the account has. '' when the account is gone. */
function accountLabel(accounts: MailAccountDto[], accountId: string): string {
  const account = accounts.find((one) => one.accountId === accountId);
  if (!account) return '';
  return account.displayName?.trim() || account.address || '';
}

export function MailAskDrawer({ ask, accounts }: { ask: MailAsk; accounts: MailAccountDto[] }) {
  const label = accountLabel(accounts, ask.accountId);
  const quote = mailAskQuote(ask.message, label, ask.bodyText);
  const objectKey = mailAskKey(ask.accountId, ask.messageId);
  return (
    <AskObjectDrawer
      // One drawer per mail: asking about another mail while this one is open starts from a clean view
      // (and the old one's focus return runs), never from this mail's draft or pending state.
      key={objectKey}
      objectKey={objectKey}
      title="Ask Walnut"
      quote={quote}
      agentId={MAIL_ASK_AGENT}
      // `window.location.origin`: the block carries a link back to THIS console, and a hard-coded host
      // would send a phone's Walnut to the Mac's.
      contextBlock={mailContextBlock(ask.message, label, ask.bodyText, window.location.origin)}
      contextName="Mail you are asking about"
      {...(ask.preset ? { preset: ask.preset, autoSend: true } : {})}
      onClose={closeMailAsk}
      // Back to the row the menu opened on, which is where the person's place in the list is.
      restoreFocusTo={mailRowSelector(ask.accountId, ask.messageId)}
    />
  );
}
