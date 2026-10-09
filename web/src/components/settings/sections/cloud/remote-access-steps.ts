/**
 * The three steps of the "Reach Walnut from anywhere" card (Settings, Phones &
 * Cloud), derived from GET /api/devices/tailscale and the paired-device list.
 * Pure, so every state is unit-tested (tests/web/remote-access-steps.test.ts)
 * apart from the React card (RemoteAccessCard.tsx).
 *
 * Dot colours: `pending` (muted, not yet), `action` (amber, your turn),
 * `done` (green). A phone paired through any address learns the tailnet route
 * by itself, so an already-paired phone only needs Walnut opened once.
 */

/** Tailscale's download page: the install on a machine that is not a Mac. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
/** Tailscale for iPhone and iPad. */
export const TAILSCALE_APP_STORE_URL = 'https://apps.apple.com/app/tailscale/id1470499037';
/** Tailscale for macOS on the Mac App Store: one Get click, no password, no Terminal. */
export const TAILSCALE_MAC_APP_STORE_URL = 'https://apps.apple.com/app/tailscale/id1475387142';
export const TAILSCALE_PLAY_URL = 'https://play.google.com/store/apps/details?id=com.tailscale.ipn';

export interface TailscalePeerInfo {
  hostName: string;
  os: string;
  online: boolean;
}

export interface TailscaleInstallJob {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  log: string[];
  error?: string;
}

/** GET /api/devices/tailscale. */
export interface TailscaleDetailResponse {
  installed: boolean;
  running: boolean;
  dnsName?: string;
  address?: string;
  loginUrl?: string;
  peers: TailscalePeerInfo[];
  /** `macOS` is absent from a server older than the field; read as true. */
  install: { brew: boolean; macOS?: boolean; job: TailscaleInstallJob | null };
}

/** The slice of a GET /api/devices entry the pairing step reads. */
export interface PairedDeviceLike {
  name: string;
  role?: string;
  platform?: string;
  info?: { os?: string; model?: string };
}

export type StepDot = 'pending' | 'action' | 'done';

export type MacStepKind = 'checking' | 'unknown' | 'not-installed' | 'installing' | 'not-running' | 'running';

export interface MacStep {
  dot: StepDot;
  kind: MacStepKind;
  /** This machine is a Mac: the App Store is the install, `open -a` the way in. Elsewhere: a download link and a terminal. */
  macOS: boolean;
  /** `Install with Homebrew` is offered. */
  canBrew: boolean;
  /** The last brew run failed and nothing has replaced it: show its sentence. */
  installError?: string;
  /** The last few lines of a running install. */
  logTail: string[];
  loginUrl?: string;
  /** dnsName, else the 100.x address. */
  connectedAs?: string;
}

export interface PhoneStep {
  dot: StepDot;
  /** The online phone that proves this step. */
  onlinePhone?: string;
  /** A phone that is on the tailnet but switched off right now. */
  offlinePhone?: string;
  /** Show the App Store QR and the store links (this is the step to do now). */
  showStores: boolean;
  /**
   * The phone can be seen at all: only the Tailscale CLI lists peers. A Mac on
   * another tailnet client (Headscale, Netbird) never turns this step green.
   */
  detectable: boolean;
}

export interface PairStep {
  dot: StepDot;
  paired: boolean;
  /** Clicking the row picks the tailnet address in the pairing picker. */
  canChooseTailnet: boolean;
}

export interface RemoteAccessSteps {
  mac: MacStep;
  phone: PhoneStep;
  pair: PairStep;
  allDone: boolean;
}

/** Last lines of a running install shown under the progress line. */
export const LOG_TAIL_LINES = 3;

const MOBILE_OS = /^(ios|ipados|android)$/i;

export function isPhonePeer(peer: TailscalePeerInfo): boolean {
  return MOBILE_OS.test(peer.os.trim());
}

/**
 * Whether a paired phone exists. An entry counts when its self-report or
 * platform says iOS (or Android); with no platform at all, any real device
 * does. This Mac's own sync credential, simulators and signed-in browsers never count.
 */
export function hasPairedPhone(devices: readonly PairedDeviceLike[]): boolean {
  return devices.some((d) => {
    if (d.role === 'self' || d.role === 'simulator' || d.role === 'browser') return false;
    const said = `${d.platform ?? ''} ${d.info?.os ?? ''} ${d.info?.model ?? ''}`.trim();
    if (!said) return true;
    return /\b(ios|ipados|iphone|ipad|android)/i.test(said);
  });
}

/**
 * The three steps. `status` null = the first answer has not come yet (or
 * never came: `failed`). `devices` null = the device list is still loading.
 */
export function deriveRemoteAccessSteps(
  status: TailscaleDetailResponse | null,
  devices: readonly PairedDeviceLike[] | null,
  opts: { failed?: boolean; tailnetOffered?: boolean } = {},
): RemoteAccessSteps {
  const mac = macStep(status, !!opts.failed);
  const macDone = mac.dot === 'done';

  const phones = status?.peers.filter(isPhonePeer) ?? [];
  const online = phones.find((p) => p.online);
  const offline = phones.find((p) => !p.online);
  const phoneDone = macDone && !!online;
  const phone: PhoneStep = {
    // Peers are visible only once this Mac is on the tailnet.
    dot: phoneDone ? 'done' : macDone ? 'action' : 'pending',
    ...(online ? { onlinePhone: online.hostName } : {}),
    ...(!online && offline ? { offlinePhone: offline.hostName } : {}),
    showStores: macDone && !online,
    detectable: !!status?.installed,
  };

  const paired = devices ? hasPairedPhone(devices) : false;
  const ready = macDone && phoneDone;
  const pair: PairStep = {
    dot: paired ? 'done' : ready ? 'action' : 'pending',
    paired,
    canChooseTailnet: !paired && macDone && opts.tailnetOffered !== false,
  };

  return { mac, phone, pair, allDone: mac.dot === 'done' && phone.dot === 'done' && pair.dot === 'done' };
}

function macStep(status: TailscaleDetailResponse | null, failed: boolean): MacStep {
  const macOS = status?.install.macOS !== false;
  const empty = { macOS, canBrew: false, logTail: [] as string[] };
  if (!status) return { dot: 'pending', kind: failed ? 'unknown' : 'checking', ...empty };
  const job = status.install.job;
  if (status.running) {
    const connectedAs = status.dnsName || status.address;
    return { dot: 'done', kind: 'running', ...empty, ...(connectedAs ? { connectedAs } : {}) };
  }
  if (status.installed) {
    return { dot: 'action', kind: 'not-running', ...empty, ...(status.loginUrl ? { loginUrl: status.loginUrl } : {}) };
  }
  if (job?.state === 'running') {
    return { dot: 'action', kind: 'installing', ...empty, logTail: job.log.slice(-LOG_TAIL_LINES) };
  }
  return {
    dot: 'action',
    kind: 'not-installed',
    ...empty,
    canBrew: macOS && status.install.brew,
    ...(job?.state === 'failed' && job.error ? { installError: job.error } : {}),
  };
}

/**
 * 5s while this Mac or the phone still has a step to do, 60s once both are on
 * the tailnet (or the phone cannot be seen, so asking faster changes nothing).
 */
export function pollIntervalMs(steps: RemoteAccessSteps): number {
  const phoneSettled = steps.phone.dot === 'done' || !steps.phone.detectable;
  return steps.mac.dot === 'done' && phoneSettled ? 60_000 : 5_000;
}
