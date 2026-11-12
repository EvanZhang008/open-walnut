import { useEffect, useState } from 'react';
import { openAgentRef } from '@/utils/agent-ref-open';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { taskPath } from '@/utils/task-path';
import { getLetter, type LetterDetail, type LetterEnvelope } from '@/api/human-inbox';
import { LetterBody } from './LetterBody';

/** Body-only view. Replies and decisions stay in the shared full reader. */
export function LetterCardBody({ letter, expanded, onOpen, onNavigate }: { letter: LetterEnvelope; expanded: boolean; onOpen: () => void; onNavigate: (to: string) => void }) {
  const [detail, setDetail] = useState<LetterDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const navigate = onNavigate;
  const source = detail?.sender ?? letter.sender ?? { unknownSource: true };
  const file = useAgentFileOpener(source);
  const onBodyClick = useEntityClickHandler(
    (id) => navigate(taskPath(id)), (id) => navigate(`/sessions?id=${id}`),
    file.onFileOpen, file.fileHost, file.fileSessionId, file.refusesAll,
  );

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    let live = true;
    setFailed(false);
    getLetter(letter.id, { signal: controller.signal }).then((result) => {
      if (live) setDetail(result);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; controller.abort(); };
  }, [letter.id, expanded, attempt]);

  return (
    <div className="hib-card-content" onClick={(event) => event.stopPropagation()}>
      {failed ? <div className="hib-note hib-note-error" role="alert">
        Could not load this letter. <button className="hib-row-btn" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
      </div> : detail ? <>
        {detail.bodyMissing ? <div className="hib-note">The letter body is unavailable.</div> :
          <LetterBody body={detail.body ?? ''} format={detail.bodyFormat} subject={detail.subject} bodyUrl={detail.bodyUrl} source={source} onClick={onBodyClick}
            onRefOpen={(ref) => { if (ref.kind === 'file') file.onFileOpen?.(ref.path, ref.line, undefined, ref.endLine); else openAgentRef(ref, navigate); }} />}

      </> : <div className="hib-note" role="status">Loading letter…</div>}
      <button className="hib-row-btn hib-card-open" onClick={onOpen}>Open full letter</button>
    </div>
  );
}
