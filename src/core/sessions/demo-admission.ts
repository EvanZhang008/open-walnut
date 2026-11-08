// Demo stop fence: a timer in flight must not queue, start or resume work while the Demo confirms its sessions stopped.

let closed = false;

export class DemoAdmissionClosedError extends Error {
  readonly code = 'demo_stopping';
  constructor() {
    super('Demo is stopping; no new work is accepted');
    this.name = 'DemoAdmissionClosedError';
  }
}

// Never reopened in a process, so a failed stop stays closed.
export function closeDemoAdmission(): void {
  closed = true;
}

export function demoAdmissionClosed(): boolean {
  return closed;
}

export function assertDemoAdmission(): void {
  if (closed) throw new DemoAdmissionClosedError();
}

// Closes before its first await, so the wake clocks stopped next cannot slip a send in first.
export async function closeDemoWork(): Promise<void> {
  closeDemoAdmission();
  const [{ stopWaitUntilWatch }, { stopPromiseAlarms }, { terminalManager }] = await Promise.all([
    import('../task-wait-until.js'),
    import('./promise-alarm.js'),
    import('../../web/terminal/terminal-manager.js'),
  ]);
  stopWaitUntilWatch();
  stopPromiseAlarms();
  await terminalManager.waitForOpening();
}

export function resetDemoAdmissionForTests(): void {
  closed = false;
}
