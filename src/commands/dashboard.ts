import type { GlobalOptions, DashboardData } from '../core/types.js';
import { outputJson } from '../utils/json-output.js';
import { renderDashboard } from '../utils/display.js';

/**
 * Run the dashboard command: load data and render.
 */
export async function runDashboard(globals: GlobalOptions): Promise<void> {
  const { getDashboardData } = await import('../core/task-manager.js');
  const data: DashboardData = await getDashboardData();

  if (globals.json) {
    outputJson(data);
  } else {
    renderDashboard(data);
  }
}
