/**
 * The Where picker's levels row (experiment `project_first_start`, design A): the saved folder (or
 * the one being browsed) cut into its levels under the search field. Pointing at a level strikes
 * out the ones after it; a click keeps the path up to it and browses there. More than 6 levels
 * fold to the first, `…` and the last 3; the `…` opens the levels in between in a small menu.
 */
import { useRef, useState } from 'react';
import { ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { ProjectStartFlyout } from './ProjectStartFlyout';
import { foldLevels, pathLevels } from './draft-where-find';

export function DraftWhereLevels({ label, path, onLevel }: {
  /** "Saved · clouddev" or "In clouddev". */
  label: string;
  /** The folder as shown (`~/a/b`, `/srv/x`). */
  path: string;
  onLevel: (dir: string) => void;
}) {
  const levels = pathLevels(path);
  const { shown, folded } = foldLevels(levels);
  const [cut, setCut] = useState(-1);
  const [foldOpen, setFoldOpen] = useState(false);
  const foldRef = useRef<HTMLButtonElement>(null);
  const lastIndex = levels.length - 1;
  return (
    <div className="draft-v6-wl" data-testid="draft-v6-typed-crumbs" onMouseLeave={() => setCut(-1)}>
      <span className="draft-v6-wl-label wn-meta">{label}</span>
      <span className="draft-v6-wl-levels">
        {shown.map((l, n) => {
          const sep = n > 0 ? <span className="draft-v6-sep" aria-hidden="true">{ICON_CHEVRON_RIGHT}</span> : null;
          if (l === 'fold') {
            return (
              <span key="fold" className="draft-v6-wl-wrap">
                {sep}
                <button ref={foldRef} type="button" aria-haspopup="listbox" aria-expanded={foldOpen}
                  className={`btn btn-link draft-v6-wl-level${cut === 0 ? ' is-cut' : ''}`} title="The levels in between" data-testid="draft-v6-levels-fold"
                  onMouseDown={(e) => e.preventDefault()} onClick={() => setFoldOpen((o) => !o)}><span className="draft-v6-wl-text">…</span></button>
                <ProjectStartFlyout open={foldOpen} anchorRef={foldRef} onClose={() => setFoldOpen(false)} label="Levels in between"
                  className="draft-v6-menu draft-v6-levels-menu" testId="draft-v6-levels-menu" minHeight={120}>
                  <div role="listbox" aria-label="Levels in between">
                    {folded.map((f) => (
                      <button key={f.dir} type="button" role="option" aria-selected={false} className="draft-v6-option wn-pick-row" title={`Keep up to ${f.dir}`}
                        onClick={() => { setFoldOpen(false); onLevel(f.dir); }}>
                        <span className="draft-v6-option-text"><span className="draft-v6-option-name wn-title">{f.label}</span>
                          <span className="draft-v6-option-line"><bdi>{f.dir}</bdi></span></span>
                      </button>
                    ))}
                  </div>
                </ProjectStartFlyout>
              </span>
            );
          }
          const i = levels.indexOf(l);
          const isLast = i === lastIndex;
          return (
            <span key={l.dir} className="draft-v6-wl-wrap">
              {sep}
              <button type="button" className={`btn btn-link draft-v6-wl-level${isLast ? ' is-last' : ''}${cut >= 0 && i > cut ? ' is-cut' : ''}`}
                data-testid="draft-v6-level" data-dir={l.dir}
                title={isLast ? 'This folder' : 'Keep up to here: drop the levels after it'}
                onMouseEnter={() => setCut(isLast ? -1 : i)} onFocus={() => setCut(isLast ? -1 : i)} onBlur={() => setCut(-1)}
                onMouseDown={(e) => e.preventDefault()} onClick={() => { setCut(-1); onLevel(l.dir); }}>
                <span className="draft-v6-wl-text">{l.label}</span>
              </button>
            </span>
          );
        })}
      </span>
    </div>
  );
}
