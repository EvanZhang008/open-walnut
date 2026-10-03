/**
 * The CPU profiler behind the stall flight recorder (stall-recorder.ts), as
 * titled profiles that may overlap so a rotation never leaves V8's profiler
 * idle (see the recorder's header for the measured cost of an idle restart).
 */

/**
 * Titled profiles that may overlap. begin() of a second title while one is
 * running is cheap; end() returns that title's samples only.
 */
export interface ProfilerDriver {
  begin(title: string): Promise<void>;
  end(title: string): Promise<CpuProfile>;
  close(): Promise<void>;
}

export interface CpuProfile {
  nodes: unknown[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/**
 * The in-process inspector as a ProfilerDriver. Titled profiles come from the
 * V8 console's profile()/profileEnd() (inspector.console, so a patched global
 * console cannot interfere); each arrives as Profiler.consoleProfileFinished on
 * this session. A titled profile only starts in a session whose Profiler domain
 * is enabled, which is why the session enables it first.
 */
export async function connectInspectorDriver(intervalUs: number): Promise<ProfilerDriver | null> {
  type V8Console = { profile?: (title: string) => void; profileEnd?: (title: string) => void };
  const inspector = await import('node:inspector');
  const vc = (inspector as unknown as { console?: V8Console }).console;
  if (typeof vc?.profile !== 'function' || typeof vc?.profileEnd !== 'function') return null;
  const s = new inspector.Session();
  s.connect();
  const post = (method: string, params?: Record<string, unknown>): Promise<void> => new Promise((resolve, reject) => {
    s.post(method, params ?? {}, (err: Error | null) => (err ? reject(err) : resolve()));
  });
  try {
    await post('Profiler.enable');
    await post('Profiler.setSamplingInterval', { interval: intervalUs });
  } catch (err) {
    try { s.disconnect(); } catch { /* gone */ }
    throw err;
  }
  const waiting = new Map<string, (profile: CpuProfile) => void>();
  s.on('Profiler.consoleProfileFinished', (msg: { params?: { title?: string; profile?: CpuProfile } }) => {
    const title = msg.params?.title;
    const done = title ? waiting.get(title) : undefined;
    if (done && msg.params?.profile) { waiting.delete(title!); done(msg.params.profile); }
  });
  return {
    begin: async (title) => { vc.profile!(title); },
    end: (title) => new Promise<CpuProfile>((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(title); reject(new Error('profile end timed out')); }, 10_000);
      timer.unref?.();
      waiting.set(title, (p) => { clearTimeout(timer); resolve(p); });
      vc.profileEnd!(title);
    }),
    close: async () => {
      waiting.clear();
      try { await post('Profiler.disable'); } catch { /* not enabled */ }
      try { s.disconnect(); } catch { /* already gone */ }
    },
  };
}
