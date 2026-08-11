/**
 * ProjectSourcePicker — chip row choosing which provider a NEW project syncs to.
 *
 * "Local" (never synced, the default) plus one chip per registered integration
 * plugin (server-driven via useIntegrations, so third-party plugins appear
 * without a UI change). Rendered under the "＋ New Project" inputs — both the
 * /tasks rail and the home panel's NewProjectRow — so creating a synced project
 * no longer requires the AI or a provider-side create + pull.
 *
 * Deliberately chips, not a <select>: the pickers live inside styled surfaces
 * where the OS popup clashes (see the menus & overlays rules), and the option
 * count is tiny (1 + #plugins).
 */

import { useIntegrations } from '@/hooks/useIntegrations';

export function ProjectSourcePicker({ value, onChange }: {
  /** 'local' or a plugin id. */
  value: string;
  onChange: (source: string) => void;
}) {
  const integrations = useIntegrations();
  const options = [
    { id: 'local', name: 'Local', badgeColor: undefined as string | undefined },
    ...integrations.map((i) => ({ id: i.id, name: i.name, badgeColor: i.badgeColor })),
  ];
  return (
    <div className="proj-src-picker" role="radiogroup" aria-label="Project sync provider">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`proj-src-chip${value === o.id ? ' on' : ''}`}
          // Keep focus on the name input — a click here must not blur-cancel
          // the create flow (both hosts cancel on input blur).
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); onChange(o.id); }}
          title={o.id === 'local' ? 'Not synced to any provider' : `Sync new project to ${o.name}`}
        >
          {o.badgeColor && <span className="proj-src-chip-dot" style={{ background: o.badgeColor }} />}
          {o.name}
        </button>
      ))}
    </div>
  );
}
