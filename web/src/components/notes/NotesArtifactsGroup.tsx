/**
 * "Walnut artifacts": the bottom section of the notes tree, listing Walnut's artifacts folder
 * (WALNUT_HOME/artifacts, src/web/routes/artifacts.ts) beside the user's own notes, so everything
 * the agents read as standing artifacts is in one place (2026-11-20, the user: "only use now
 * location", and he wants to look at it in one place). The org's skills, the shared notes, then one
 * group per node: its MEMORY.md, team guidance, skills, notes and reflection records.
 *
 * Collapsed by default, so the tree reads as before until it is opened; its open state, and each
 * group's, are kept in the tree's expanded-folders store under sentinel keys, as Recent's is. A file
 * opens in the app's file viewer (open-anywhere.ts). Read only here: agents write these through
 * Walnut. Listed again each time the section opens.
 */
import { useEffect, useState } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { fetchArtifacts, type ArtifactFile, type ArtifactGroup } from '@/api/artifacts';
import { openFileAnywhere } from '@/utils/open-anywhere';
import { log } from '@/utils/log';

/** Sentinel "path" of the section in the expanded-folders set (present = open). */
export const ARTIFACTS_GROUP_KEY = '__artifacts__';
const groupKey = (id: string) => `${ARTIFACTS_GROUP_KEY}:${id}`;

const KIND_LABEL: Record<ArtifactFile['kind'], string> = {
  memory: 'MEMORY.md', guidance: 'Team guidance', skill: 'skill', note: 'note', reflection: 'reflection',
};

/** A row's label: a skill by its name, a reflection by its day, the rest by file name. */
function label(f: ArtifactFile): string {
  if (f.kind === 'memory') return 'MEMORY.md';
  if (f.kind === 'guidance') return 'Team guidance';
  if (f.kind === 'reflection') return `Reflection ${f.name.replace(/\.md$/, '')}`;
  return f.name.replace(/\.md$/, '');
}

interface NotesArtifactsGroupProps {
  expandedKeys: Set<string>;
  onToggleKey: (key: string) => void;
}

export function NotesArtifactsGroup({ expandedKeys, onToggleKey }: NotesArtifactsGroupProps) {
  const open = expandedKeys.has(ARTIFACTS_GROUP_KEY);
  const [groups, setGroups] = useState<ArtifactGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useLeanCallback(() => {
    setError(null);
    fetchArtifacts()
      .then((r) => setGroups(r.groups))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('notes-artifacts', 'artifacts folder not listed', { error: message });
        setError(message);
      });
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const fileCount = groups?.reduce((n, g) => n + g.files.length, 0);

  return (
    <div className="notes-bookmarks-group notes-artifacts-group" data-testid="notes-artifacts-group">
      <div
        className="notes-tree-item notes-bookmarks-header"
        role="button"
        aria-expanded={open}
        onClick={() => onToggleKey(ARTIFACTS_GROUP_KEY)}
        title="What Walnut's agents keep as standing artifacts: skills, each node's MEMORY.md, team guidance, notes and reflections"
      >
        <span className={`notes-tree-arrow ${open ? 'expanded' : ''}`}><ChevronIcon /></span>
        <BookGlyph />
        <span className="notes-tree-name">Walnut artifacts</span>
        {open && fileCount !== undefined && <span className="notes-bookmarks-count">{fileCount}</span>}
      </div>
      {open && (
        <div className="notes-artifacts-list">
          {error && (
            <div className="notes-tree-empty">
              Not listed: {error} <button type="button" className="notes-artifacts-retry" onClick={load}>Retry</button>
            </div>
          )}
          {!error && groups === null && <div className="notes-tree-empty">Loading…</div>}
          {!error && groups?.length === 0 && <div className="notes-tree-empty">Nothing yet: agents add skills and memory as they work.</div>}
          {groups?.map((g) => {
            const gOpen = expandedKeys.has(groupKey(g.id));
            return (
              <div key={g.id} className="notes-artifacts-sub" data-testid={`notes-artifacts-${g.id}`}>
                <div
                  className="notes-tree-item notes-tree-folder notes-artifacts-sub-header"
                  role="button"
                  aria-expanded={gOpen}
                  onClick={() => onToggleKey(groupKey(g.id))}
                  title={g.title}
                >
                  <span className={`notes-tree-arrow ${gOpen ? 'expanded' : ''}`}><ChevronIcon /></span>
                  <span className="notes-tree-name">{g.title}</span>
                  <span className="notes-bookmarks-count">{g.files.length}</span>
                </div>
                {gOpen && g.files.map((f) => (
                  <div
                    key={f.path}
                    className="notes-tree-item notes-tree-file notes-bookmark-row notes-artifacts-row"
                    title={`${KIND_LABEL[f.kind]} · ${f.path}`}
                    onClick={() => openFileAnywhere({ path: f.path })}
                  >
                    <FileGlyph />
                    <span className="notes-tree-name">{label(f)}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function BookGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="notes-tree-icon">
      <path d="M3 2.5h7.5a2 2 0 0 1 2 2v9H5a2 2 0 0 1-2-2z" />
      <path d="M3 11.5a2 2 0 0 1 2-2h7.5" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="notes-tree-icon">
      <path d="M4 1.5h5l3 3v10H4z" />
      <path d="M9 1.5v3h3" />
    </svg>
  );
}
