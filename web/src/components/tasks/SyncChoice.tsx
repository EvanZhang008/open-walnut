/**
 * The create surfaces' source choice (2026-11-01, the user: "in create new task UI we should have
 * a button to select which source, local or the default source of this project"): shown only when
 * the task's project syncs to an outside service. Local keeps the task in Walnut only; the service
 * sends it there once Walnut checked it is not private (src/core/private-tasks/).
 *
 *   SyncChoiceChip   one chip in the draft column's bar: "Local" / "<service>", a click flips it
 *   SyncChoiceField  a labelled two-button row in the quick add form
 */
import { useIntegrations, getIntegrationMeta } from '@/hooks/useIntegrations';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import { projectService } from './private-task-model';

/** The project's outside service and its name, or null when the project does not sync. */
export function useProjectService(project: string | undefined): { id: string; name: string } | null {
  const integrations = useIntegrations();
  const { sourceByName } = useProjectRegistry();
  const id = projectService(project, sourceByName);
  if (!id) return null;
  return { id, name: getIntegrationMeta(integrations, id)?.name ?? id };
}

const LOCK = (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.3" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </svg>
);

export function SyncChoiceChip({ project, local, onChange, disabled }: {
  project: string | undefined;
  local: boolean;
  onChange: (local: boolean) => void;
  disabled?: boolean;
}) {
  const service = useProjectService(project);
  if (!service) return null;
  return (
    <button
      type="button"
      className={`session-action-chip draft-sync-chip${local ? ' draft-sync-chip-local' : ''}`}
      data-testid="draft-sync-chip"
      data-sync={local ? 'local' : 'project'}
      disabled={disabled}
      aria-pressed={!local}
      title={local
        ? `Local: this task stays in Walnut and never goes to ${service.name}. Click to sync it to ${service.name}.`
        : `Syncs to ${service.name} once Walnut checked it is not private. Click to keep it local.`}
      // Keep the composer's caret (WebKit blurs a textarea on a button mousedown).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => { e.stopPropagation(); onChange(!local); }}
    >
      {local && <span className="draft-sync-lock">{LOCK}</span>}
      <span className="draft-pill-key">Sync:</span>
      <span>{local ? 'Local' : service.name}</span>
    </button>
  );
}

export function SyncChoiceField({ project, local, onChange, disabled }: {
  project: string | undefined;
  local: boolean;
  onChange: (local: boolean) => void;
  disabled?: boolean;
}) {
  const service = useProjectService(project);
  if (!service) return null;
  return (
    <div className="qtc-confirm-field" data-testid="qtc-sync-choice">
      <span className="qtc-confirm-label">Sync</span>
      <div className="qtc-chips" role="radiogroup" aria-label="Where this task syncs">
        <button type="button" role="radio" aria-checked={local} className={`qtc-chip${local ? ' qtc-chip-on' : ''}`}
          data-testid="qtc-sync-local" disabled={disabled} onClick={() => onChange(true)}
          title={`Stays in Walnut, never sent to ${service.name}`}>
          Local
        </button>
        <button type="button" role="radio" aria-checked={!local} className={`qtc-chip${!local ? ' qtc-chip-on' : ''}`}
          data-testid="qtc-sync-project" disabled={disabled} onClick={() => onChange(false)}
          title={`Sent to ${service.name} once Walnut checked it is not private`}>
          {service.name}
        </button>
      </div>
    </div>
  );
}
