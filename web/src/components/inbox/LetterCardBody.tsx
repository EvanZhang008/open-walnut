import { useEffect, useState } from 'react';
import { openAgentRef } from '@/utils/agent-ref-open';
import { useAgentFileOpener } from '@/hooks/useAgentFileOpener';
import { useEntityClickHandler } from '@/hooks/useEntityClickHandler';
import { getLetter, type LetterDetail, type LetterEnvelope } from '@/api/human-inbox';
import { LetterBody } from './LetterBody';
import { LoadingState, UnavailableState } from '@/components/common/EmptyState';

/** Body-only view. Replies and decisions stay in the shared full reader. */
export function LetterCardBody({ letter, expanded, onOpen, onNavigate }: { letter: LetterEnvelope; expanded: boolean; onOpen: () => void; onNavigate: (to: string) => void }) {
  const [detail, setDetail] = useState<LetterDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const navigate = onNavigate;
  const source = detail?.sender ?? letter.sender ?? { unknownSource: true };
  const file = useAgentFileOpener(source);
  const onBodyClick = useEntityClickHandler(
    (id) => navigate(`/sessions?id=${id}`),
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
      {failed ? <UnavailableState size="section" title="Couldn't load this letter" onRetry={() => setAttempt((value) => value + 1)} />
        : detail ? <>
        {detail.bodyMissing ? <UnavailableState size="section" title="The letter body is unavailable" testId="letter-body-missing" /> :
          <LetterBody body={detail.body ?? ''} format={detail.bodyFormat} subject={detail.subject} bodyUrl={detail.bodyUrl} source={source} onClick={onBodyClick}
            onRefOpen={(ref) => { if (ref.kind === 'file') file.onFileOpen?.(ref.path, ref.line, undefined, ref.endLine); else openAgentRef(ref, navigate); }} />}

      </> : <LoadingState size="section" title="Loading letter…" />}
      <button className="btn btn-sm hib-row-btn hib-card-open" onClick={onOpen}>Open full letter</button>
    </div>
  );
}
