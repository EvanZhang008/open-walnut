/**
 * Open a project's settings pane from anywhere (the draft's project picker "Set up source…").
 * The pane lives in the task panel (TodoPanel), which listens; Home shows the panel first.
 */
export const OPEN_PROJECT_SETTINGS_EVENT = 'walnut:open-project-settings';

export function openProjectSettings(project: string): void {
  if (!project) return;
  window.dispatchEvent(new CustomEvent(OPEN_PROJECT_SETTINGS_EVENT, { detail: { project } }));
}

/** Listen for the requests; returns the unsubscribe. */
export function onOpenProjectSettings(fn: (project: string) => void): () => void {
  const handler = (e: Event) => {
    const project = (e as CustomEvent<{ project?: unknown }>).detail?.project;
    if (typeof project === 'string' && project) fn(project);
  };
  window.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, handler);
  return () => window.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, handler);
}
