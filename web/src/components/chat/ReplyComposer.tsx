/**
 * The box a person replies in, inside a card (an ask, a letter, an approval): the chat's own composer
 * (ChatInput, light), never a box of its own (2026-11-20, the user: "all the inbox like this should
 * like inputb nox, make sure they potenially reuse, liek the at works like the slash works"). So @
 * names a task or a session, / lists the asking session's commands, a pasted or dropped picture goes
 * with the words, and the mic dictates, as in the chat; what the composer learns next, this box has.
 *
 * It never takes the focus by itself (a page shows many of them). A send that fails keeps its words
 * and pictures in the box (onSend resolves false).
 */
import { useState } from 'react';
import type { ImageAttachment } from '@/api/chat';
import { ChatInput } from './ChatInput';
import { useSlashCommands } from '@/hooks/useSlashCommands';

export interface ReplyComposerProps {
  placeholder: string;
  /** The card's own box: its words and pictures wait here until sent, and come back after a
   *  failed send (ChatInput keeps them when the send says false). */
  draftKey: string;
  /** Resolves true once taken; false keeps the words and pictures in the box. */
  onSend: (text: string, images?: ImageAttachment[]) => Promise<boolean>;
  /** The session it answers: its commands on /, and where a file goes. */
  sessionId?: string | null;
  /** The task it answers for: not offered to itself on @. */
  taskId?: string;
  testId?: string;
  sendTestId?: string;
  sendTitle?: string;
}

export function ReplyComposer({ placeholder, draftKey, onSend, sessionId, taskId, testId = 'org-answer-input', sendTestId = 'org-answer-send', sendTitle = 'Send' }: ReplyComposerProps) {
  // The session's commands are read once the box is used, never for every card on a page.
  const [used, setUsed] = useState(false);
  const commands = useSlashCommands(undefined, undefined, sessionId ?? undefined, !!sessionId && used);
  return (
    <div className="org-answer-words reply-composer" data-testid="reply-composer" onFocusCapture={() => { if (!used) setUsed(true); }}>
      <ChatInput
        light
        placeholder={placeholder}
        draftKey={draftKey}
        // A file goes to the asking session's host; with none, to this machine (as the Home composer's).
        fileTarget={sessionId ? { sessionId } : {}}
        onSend={(text, images) => onSend(text, images)}
        showCommands={false}
        enableEntityMention
        {...(taskId ? { mentionSelfTaskId: taskId } : {})}
        {...(sessionId ? {
          sessionCommands: commands.items,
          searchSessionCommands: commands.search,
          onRefreshSessionCommands: commands.refresh,
          onSessionCommandsPaletteOpen: commands.onPaletteOpen,
          sessionCommandsStatus: commands.status,
        } : {})}
        inputTestId={testId}
        sendTestId={sendTestId}
        sendTitle={sendTitle}
      />
    </div>
  );
}
