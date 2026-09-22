/**
 * Mail's side of the Ask-Walnut drawer: the store's `ask` turned into `AskObjectDrawer` props.
 *
 * A thin adapter on purpose. Everything reusable (the conversation per object, the single flight, the
 * once-per-object context prefix, the preset send, Escape and the focus return) lives in
 * `AskObjectDrawer`; everything mail-shaped (the block, the quote, the key) lives in the pure
 * `mail-ask.ts`. What is left here is which agent answers and how the drawer is closed, which is the
 * only part a second surface could not share.
 *
 * `general` is the agent: this is the console's own Walnut, the same one the Ask Walnut slot talks to,
 * so a question about a mail lands in the assistant the person already knows rather than in a mail
 * specialist they have never met.
 */
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer';
import { askObjectTitle } from '@/components/chat/ask-object-conversation';
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
  return (
    <AskObjectDrawer
      objectKey={mailAskKey(ask.accountId, ask.messageId)}
      title="Ask Walnut"
      quote={quote}
      agentId={MAIL_ASK_AGENT}
      // `window.location.origin`: the block carries a link back to THIS console, and a hard-coded host
      // would send a phone's Walnut to the Mac's.
      contextBlock={mailContextBlock(ask.message, label, ask.bodyText, window.location.origin)}
      {...(ask.preset ? { preset: ask.preset, autoSend: true } : {})}
      // Named for the agent's conversation list, where asks from every surface sit together:
      // `Mail: <who>: <subject>`. The drawer's own default would title it from the quote's preview,
      // which here begins with the subject and then runs into the body.
      conversationTitle={askObjectTitle(`Mail: ${quote.who}`, ask.message.subject || '(no subject)')}
      placeholder="Ask about this mail"
      emptyText={`Ask Walnut about this mail${quote.who ? ` from ${quote.who}` : ''}.`}
      onClose={closeMailAsk}
      // Back to the row the menu opened on, which is where the person's place in the list is.
      restoreFocusTo={mailRowSelector(ask.accountId, ask.messageId)}
    />
  );
}
