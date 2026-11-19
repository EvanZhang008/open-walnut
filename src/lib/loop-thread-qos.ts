/**
 * Raise the server's loop thread to QoS user-initiated on macOS, so the thread
 * that answers every request is not queued behind the Mac's default-band work.
 *
 * The production server runs as a launchd job with ProcessType Interactive:
 * base priority 31, the default band (scripts/dev-prod.sh). On a busy Mac (load
 * 19 to 28 on 14 cores, 2026-11-19) that band is full of the user's own work at
 * 31, and the loop thread waited for a CPU in the middle of its calls: a session
 * row INSERT that needs 1.5 ms of CPU took 300 to 650 ms (41 of them in 11 h,
 * 12.2 s, with 2488 involuntary context switches, no voluntary ones, and no
 * other process holding the database: src/core/blocking-calls.ts measured it).
 * User-initiated (base priority 37) is the band macOS gives work a person is
 * waiting on, which a request to the server is.
 *
 * The thread that calls this moves, and so do the threads it creates after it
 * (a pthread without a QoS attribute starts in its creator's band): the Worker
 * threads the server starts later. The heavy one, the VACUUM INTO backup,
 * lowers itself to utility (src/lib/sqlite.ts). Child processes do not follow:
 * macOS sets a spawned process's band from its own launch, so the children keep
 * theirs (the daemon and every agent session are clamped to utility,
 * src/lib/background-qos.ts; the rest stay in the default band). Raised only where the
 * deploy raised the process (the clamp request, which only the Interactive job
 * carries), or when WALNUT_LOOP_QOS=1; WALNUT_LOOP_QOS=0 keeps it as launched.
 * Never throws: a runtime without bun:ffi, another platform, or a refusal
 * leaves the thread as it was and says why.
 */

/** QOS_CLASS_USER_INITIATED in <sys/qos.h>. */
export const QOS_CLASS_USER_INITIATED = 0x19;

export interface QosCalls {
  set(qosClass: number, relativePriority: number): number;
  current(): number;
}

export interface LoopQosResult {
  applied: boolean;
  /** Why it was not raised. */
  reason?: 'not-darwin' | 'not-requested' | 'turned-off' | 'unavailable' | 'refused';
  before?: string;
  after?: string;
  error?: string;
}

type FfiSymbols = { pthread_set_qos_class_self_np(c: number, p: number): number; qos_class_self(): number };
type BunFfi = { dlopen(path: string, defs: Record<string, { args: string[]; returns: string }>): { symbols: FfiSymbols } };

async function darwinQosCalls(): Promise<QosCalls> {
  // bun's own module (Walnut runs only on bun); named through a variable so the
  // type check and the Node bundles never look for it.
  const ffiModule = 'bun:ffi';
  const { dlopen } = (await import(ffiModule)) as BunFfi;
  const lib = dlopen('/usr/lib/libSystem.B.dylib', {
    pthread_set_qos_class_self_np: { args: ['u32', 'i32'], returns: 'i32' },
    qos_class_self: { args: [], returns: 'u32' },
  });
  return {
    set: (qosClass, relativePriority) => Number(lib.symbols.pthread_set_qos_class_self_np(qosClass, relativePriority)),
    current: () => Number(lib.symbols.qos_class_self()),
  };
}

const hex = (n: number): string => `0x${n.toString(16)}`;

export async function raiseLoopThreadQos(opts: {
  /** The deploy raised this process (takeQosClampRequest()). */
  raisedByDeploy: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  calls?: () => Promise<QosCalls>;
}): Promise<LoopQosResult> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  // It describes how THIS process should run: taken out of the env before a
  // child copies it (a server an agent starts would raise itself too).
  const asked = env.WALNUT_LOOP_QOS;
  delete env.WALNUT_LOOP_QOS;
  if (platform !== 'darwin') return { applied: false, reason: 'not-darwin' };
  if (asked === '0') return { applied: false, reason: 'turned-off' };
  if (!opts.raisedByDeploy && asked !== '1') return { applied: false, reason: 'not-requested' };
  let calls: QosCalls;
  try {
    calls = await (opts.calls ?? darwinQosCalls)();
  } catch (err) {
    return { applied: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const before = calls.current();
    const rc = calls.set(QOS_CLASS_USER_INITIATED, 0);
    const after = calls.current();
    if (rc !== 0) return { applied: false, reason: 'refused', before: hex(before), after: hex(after), error: `pthread_set_qos_class_self_np returned ${rc}` };
    return { applied: true, before: hex(before), after: hex(after) };
  } catch (err) {
    return { applied: false, reason: 'unavailable', error: err instanceof Error ? err.message : String(err) };
  }
}
