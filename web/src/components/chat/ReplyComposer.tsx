/**
 * The box a person replies in, inside a card (an ask, a letter, an approval): the chat's own composer
 * (ChatInput, light), never a box of its own (2026-11-20, the user: "all the inbox like this should
 * like inputb nox, make sure they potenially reuse, liek the at works like the slash works"). So @
 * names a task or a session, / lists the asking session's commands, a pasted or dropped picture goes
 * with the words, and the mic dictates, as in the chat; what the composer learns next, this box has.
 *
 * It never takes the focus by itself (a page shows many of them). `initial` puts back the words of a
 * send that failed.
 */
import { useState } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { ChatInput } from './ChatInput';
import { useSlashCommands } from '@/hooks/useSlashCommands';

export interface ReplyComposerProps {
  placeholder: string;
  /** The words are kept under this key until sent: the ask's own box (the session's composer, the
   *  Board choice's), else one of the card's own. */
  draftKey: string;
  /** Words to put back (a failed send's). */
  initial?: string;
  onSend: (text: string, images?: ImageAttachment[]) => void;
  /** The session it answers: its commands on /. */
  sessionId?: string | null;
  /** The task it answers for: not offered to itself on @. */
  taskId?: string;
  testId?: string;
  sendTestId?: string;
  sendTitle?: string;
}

export function ReplyComposer(props: ReplyComposerProps) {
  return (
    <div className="org-answer-words reply-composer" data-testid="reply-composer">
      {props.sessionId ? <WithCommands {...props} sessionId={props.sessionId} /> : <Box {...props} />}
    </div>
  );
}

function WithCommands(props: ReplyComposerProps & { sessionId: string }) {
  const slash = useSlashCommands(undefined, undefined, props.sessionId);
  return <Box {...props} commands={slash} />;
}

function Box({ placeholder, draftKey, initial, onSend, sessionId, taskId, testId = 'org-answer-input', sendTestId = 'org-answer-send', sendTitle = 'Send', commands }: ReplyComposerProps & {
  commands?: ReturnType<typeof useSlashCommands>;
}) {
  // A failed send's words, put in once when it comes back.
  const [prefill] = useState(() => (initial ? { text: initial, nonce: Date.now() } : null));
  return (
    <ChatInput
      light
      placeholder={placeholder}
      draftKey={draftKey}
      // Any file goes where its words go: to the asking session's host, else this machine.
      fileTarget={sessionId ? { sessionId } : {}}
      onSend={(text, images) => { onSend(text, images); }}
      showCommands={false}
      enableEntityMention
      {...(taskId ? { mentionSelfTaskId: taskId } : {})}
      {...(commands ? {
        sessionCommands: commands.items,
        searchSessionCommands: commands.search,
        onRefreshSessionCommands: commands.refresh,
        onSessionCommandsPaletteOpen: commands.onPaletteOpen,
        sessionCommandsStatus: commands.status,
      } : {})}
      {...(prefill ? { prefillText: prefill.text, prefillNonce: prefill.nonce } : {})}
      inputTestId={testId}
      sendTestId={sendTestId}
      sendTitle={sendTitle}
    />
  );
}
