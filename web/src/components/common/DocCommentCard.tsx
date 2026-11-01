/**
 * One comment on a document, in the comment column beside it (DocCommentsLayer):
 * its thread (the user's comment, the AI's replies, the user's replies), a Reply
 * box and Resolve / Reopen. Folded to its first post until it is the current one.
 * The draft of a new comment is the same card with only the box.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { AnswerBox } from '@/components/common/AnswerBox';
import { useDraft } from '@/hooks/useDraft';
import { AI_AUTHOR, USER_AUTHOR, type DocComment } from '@/utils/doc-comments';
import { draftHash, draftKey } from '@/utils/drafts';
import { snippetOf } from '@/utils/passage-comments';
import { timeAgo } from '@/utils/time';

interface CardProps {
  /** The doc: the reply box keeps its words under the doc and the comment. */
  docPath: string;
  comment: DocComment;
  current: boolean;
  /** The commented words are no longer in the doc. */
  outdated: boolean;
  /** A post of the user's here still waits for the next message to the AI. */
  queued: boolean;
  onFocus: () => void;
  onReply: (text: string) => void;
  onResolve: (resolved: boolean) => void;
  onDelete: () => void;
  /** Escape in the reply box: the card stops being the current one. */
  onLeave: () => void;
}

/** Escape in a comment box is the box's: it must not also close the panel's view. */
const escapeOnly = (then: () => void) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
  e.preventDefault();
  e.stopPropagation();
  then();
};

function Post({ author, at, text }: { author: string; at: string; text: string }) {
  const ai = author === AI_AUTHOR;
  return (
    <div className={`doc-comment-post${ai ? ' is-ai' : ''}`} data-testid="doc-comment-post" data-author={author}>
      <div className="doc-comment-post-head">
        <span className="doc-comment-author">{author === USER_AUTHOR ? 'You' : author}</span>
        {at && <span className="doc-comment-time" title={at}>{timeAgo(at, { long: true })}</span>}
      </div>
      <div className="doc-comment-post-text">{text}</div>
    </div>
  );
}

export function DocCommentCard({ docPath, comment: c, current, outdated, queued, onFocus, onReply, onResolve, onDelete, onLeave }: CardProps) {
  const reply = useDraft(current ? draftKey('doc-comment-reply', docPath, c.id) : null);
  const resolved = c.status === 'resolved';
  const send = (words: string) => {
    const key = reply.key;
    onReply(words);
    reply.clear(key, words);
  };
  const [first, ...rest] = c.thread;
  return (
    <div
      className={`doc-comment-card${current ? ' is-current' : ''}${resolved ? ' is-resolved' : ''}${outdated ? ' is-outdated' : ''}`}
      data-testid="doc-comment-card"
      data-comment-id={c.id}
      data-status={c.status}
      onPointerDown={(e) => { e.stopPropagation(); if (!current) onFocus(); }}
    >
      {resolved && (
        <div className="doc-comment-state">
          Resolved{c.resolvedBy ? ` by ${c.resolvedBy === USER_AUTHOR ? 'you' : c.resolvedBy}` : ''}
          {c.resolvedAt ? ` · ${timeAgo(c.resolvedAt, { long: true })}` : ''}
        </div>
      )}
      {outdated && (
        <div className="doc-comment-state is-outdated" title={c.text}>
          The words it was on changed: ❝ {snippetOf(c.text, 90)}
        </div>
      )}
      {first && <Post {...first} />}
      {current
        ? rest.map((p, i) => <Post key={i} {...p} />)
        : rest.length > 0 && <div className="doc-comment-more">{rest.length === 1 ? '1 reply' : `${rest.length} replies`}</div>}
      {queued && <div className="doc-comment-queued">Goes to the AI with your next message</div>}
      {current && (
        <div className="doc-comment-actions">
          {!resolved && (
            <AnswerBox
              value={reply.text}
              onChange={reply.setText}
              onSubmit={send}
              sendLabel={reply.text.trim() ? 'Reply' : undefined}
              sendTestId="doc-comment-reply-send"
              testId="doc-comment-reply"
              draftKey={reply.key}
              placeholder="Reply…"
              ariaLabel="Reply to this comment"
              className="doc-comment-answer"
              onKeyDown={escapeOnly(onLeave)}
            />
          )}
          <div className="doc-comment-buttons">
            <button type="button" className="doc-comment-btn" data-testid="doc-comment-resolve" onClick={() => onResolve(!resolved)}>
              {resolved ? 'Reopen' : 'Resolve'}
            </button>
            <button type="button" className="doc-comment-btn is-quiet" data-testid="doc-comment-delete" onClick={onDelete}>Delete</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A new comment's box. Its words are kept under the doc and the passage: Escape
 * (the layer's) closes the card and keeps them for the next Comment on the same
 * words; Cancel throws them away.
 */
export function DocCommentDraft({ docPath, passage, onSubmit, onCancel }: {
  docPath: string;
  passage: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const draft = useDraft(draftKey('doc-comment-new', docPath, draftHash(passage)));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  const submit = (words: string) => {
    const key = draft.key;
    onSubmit(words);
    draft.clear(key, words);
  };
  return (
    <div className="doc-comment-card is-current is-draft" data-testid="doc-comment-draft" onPointerDown={(e) => e.stopPropagation()}>
      <AnswerBox
        value={draft.text}
        onChange={draft.setText}
        onSubmit={submit}
        sendLabel="Comment"
        sendTestId="doc-comment-draft-save"
        testId="doc-comment-draft-input"
        draftKey={draft.key}
        boxRef={ref}
        minRows={2}
        placeholder="Comment…"
        ariaLabel="Comment on this passage"
        className="doc-comment-answer"
        // Escape closes the card and keeps the words for the next Comment on these words.
        onKeyDown={escapeOnly(onCancel)}
      />
      <div className="doc-comment-buttons">
        <button type="button" className="doc-comment-btn" onClick={() => { draft.clear(); onCancel(); }}>Cancel</button>
      </div>
    </div>
  );
}
