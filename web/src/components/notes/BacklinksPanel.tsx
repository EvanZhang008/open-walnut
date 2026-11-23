import { useState } from 'react';
import { useBacklinks } from '@/hooks/useBacklinks';
import { DisclosureChevron } from '@/components/controls';

interface BacklinksPanelProps {
  notePath: string;
  onNavigate: (path: string) => void;
}

/**
 * Index-backed backlinks (GET /backlinks, id-keyed — §1.2 #9). Ambiguous inbound
 * edges (a bare `[[Title]]` pointing at one of several same-named notes) are
 * shown EXPLICITLY ("links to one of N notes named X") rather than hidden or
 * silently duplicated under each candidate — the Obsidian-native ambiguous-edge
 * contract (§2.2 / §4.3).
 */
export function BacklinksPanel({ notePath, onNavigate }: BacklinksPanelProps) {
  const { backlinks, loading } = useBacklinks(notePath);
  const [expanded, setExpanded] = useState(false);

  if (loading || backlinks.length === 0) return null;

  return (
    <div className="notes-backlinks-panel">
      <button
        className="notes-backlinks-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`notes-backlinks-arrow ${expanded ? 'expanded' : ''}`}>
          <DisclosureChevron open={expanded} />
        </span>
        <span className="notes-backlinks-count">{backlinks.length} backlink{backlinks.length !== 1 ? 's' : ''}</span>
      </button>
      {expanded && (
        <div className="notes-backlinks-list">
          {backlinks.map(bl => {
            const ambiguous = bl.status === 'ambiguous';
            const candidateCount = bl.candidates?.length ?? 0;
            return (
              <div
                key={bl.path}
                className={`notes-backlink-item ${ambiguous ? 'ambiguous' : ''}`}
                onClick={() => onNavigate(bl.path)}
              >
                <span className="notes-backlink-name">{bl.title || bl.name}</span>
                {ambiguous && (
                  // The link resolves to more than one same-named note; surface it
                  // instead of mis-resolving (§4.3). The source note still opens on
                  // click; the badge explains the ambiguity to the user.
                  <span className="notes-backlink-ambiguous" title="This link matches more than one note by name">
                    ambiguous{candidateCount > 1 ? ` — one of ${candidateCount}` : ''}
                  </span>
                )}
                <span className="notes-backlink-snippet">{bl.snippet}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
