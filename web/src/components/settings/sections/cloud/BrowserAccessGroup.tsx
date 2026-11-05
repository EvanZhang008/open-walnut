/**
 * "Open from a browser": this server's tunnel and the codes that sign a browser
 * in (docs/plan/walnut-servers-everywhere.md, "Exposure"). Settings, Phones &
 * Cloud, on a primary.
 *
 *   Tunnel             which provider (the built-in command, or one a plugin added)
 *   <its options>      a tunnel name, say; saved on Enter or when the field loses focus (none
 *                      for an option the provider fills itself, `hidden`)
 *   Runs on            an always-on host the provider names, or this computer
 *                      (src/core/expose/placement.ts); shown only when there is a host to pick
 *   Open from anywhere the switch, with one sentence of state and Retry when it waits
 *   Open on your phone ONE link, made by itself once connected: opened on the phone, Walnut opens
 *                      there signed in (its one-time code rides in the link). No second address
 *                      (2026-11-03, the user asked for one link that just opens). Beside it, the
 *                      QR code of that same link, for the phone's camera (2026-11-04, the user:
 *                      "the QR code is still needed"); it shows only once drawn for the link on
 *                      screen. It goes to an always-on host's tunnel first; the text hides its
 *                      code, Copy takes it whole; kept across visits, and replaced when it runs
 *                      out, when a phone signed in with it (browser:signed-in), or when the
 *                      address changed. The QR carries the code, which is single use and lasts
 *                      ten minutes.
 *
 * State comes from GET /api/expose, every 3s while the tunnel is moving or waits
 * on the person and every 30s once settled, never while the tab is hidden.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { apiGet, apiPost, apiPut } from '@/api/client';
import { answerFoundHost } from '@/api/hosts';
import { log } from '@/utils/log';
import { SettingsEmpty, SettingsGroup, SettingsNotice, SettingsRow } from '../../SettingsSection';
import { BROWSER_SIGNED_IN_EVENT } from './devices-list';
import { SettingsButton } from '../../inputs/SettingsButton';
import { ToggleSwitch } from '../../inputs/ToggleSwitch';
import { SegmentedControl } from '../../inputs/SegmentedControl';
import { CopyButton } from '../../inputs/CopyButton';
import { copyTextRobust } from '@/utils/clipboard';
import { saveErrorMessage } from '../../settings-pane-context';
import { DEVICES_TAB } from '../../settings-way-panes';
import { describeExpose, exposePollMs, type ExposeResponse, type ExposeStatus, optionFits } from './browser-access-status';
import { isDeviceCaller } from './device-caller';
import { PHONE_LINK_QR_SHOWN, phoneLinkQr } from './phone-link-qr';
import '@/styles/browser-access.css';

const PATH = '/api/expose';

/** One address the code opens Walnut at (POST /api/devices/browser-code `addresses`). */
interface SignInAddress {
  where: string;
  label: string;
  url: string;
  link: string;
  alwaysOn: boolean;
}

interface BrowserCode {
  code: string;
  expiresAt: number;
  addresses: SignInAddress[];
  /** Where the phone connects, the link's address first. A host's always-on server comes
   *  first: while this Mac sleeps, a phone signed in there still opens the copy that host
   *  keeps, and its task and note edits sync when the Mac wakes. */
  /** The tunnel address it was made for: another address makes a new one. */
  url: string;
}

/** The link this page made last (see the code state below). */
let sharedCode: BrowserCode | null = null;

/** QR codes drawn for links, by link, so a QR shows with its link at once on a revisit. Few: a
 *  link lasts ten minutes. */
const drawnQr = new Map<string, string>();


/** How long "A browser just signed in" stays after a link was used. */
const SIGNED_IN_NOTE_MS = 15_000;

/** The link as shown: its code hidden, since a screenshot or a recording of Settings must not sign anyone in. Copy takes it whole. */
export function maskedLink(link: string): string {
  return link.replace(/#pair=[^&]*$/, '#pair=••••-••••');
}

/** `heading`: Phones & Cloud names the group after its card ("Browser link"). */
export function BrowserAccessGroup({ heading = 'Open from a browser' }: { heading?: string } = {}) {
  // A browser signed in with a code is refused every code (403
  // person_at_this_machine): say where codes come from, no button.
  const [deviceCaller] = useState(isDeviceCaller);
  const [data, setData] = useState<ExposeResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refused option saves, by option: each shown under its option, whose box keeps what was typed,
  // until that option is saved or put back. No other write clears one, so the screen never shows a
  // typed value as if it were saved.
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const setOptionError = (key: string, message: string | null) =>
    setOptionErrors((prev) => {
      if (message === null && !(key in prev)) return prev;
      const next = { ...prev };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  const [options, setOptions] = useState<Record<string, string>>({});
  // The link made last, kept across visits to this page: making one per visit would push out
  // (at most five live) the one already sent to a phone.
  const [code, setCodeState] = useState<BrowserCode | null>(() => (sharedCode && sharedCode.expiresAt > Date.now() ? sharedCode : null));
  const setCode = useCallback((next: BrowserCode | null | ((prev: BrowserCode | null) => BrowserCode | null)) => {
    setCodeState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      sharedCode = value;
      return value;
    });
  }, []);
  const [codeError, setCodeError] = useState<string | null>(null);
  // The code shown in words, for a phone with no camera or shared clipboard: on a click
  // only, so a screenshot of Settings shows no code by itself; a new code hides it again.
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const readSeq = useRef(0);
  // Option fields the person is typing in: a poll must not overwrite them.
  const editing = useRef(new Set<string>());
  // What each option box last held as typed, read when a save answers: typing that went on while the
  // write was on its way is newer than what was saved, so it stays in its box.
  const typed = useRef<Record<string, string>>({});

  const apply = useCallback((next: ExposeResponse) => {
    setData(next);
    setOptions((prev) => {
      const merged = { ...next.settings.options };
      for (const key of editing.current) merged[key] = prev[key] ?? merged[key] ?? '';
      return merged;
    });
  }, []);

  const load = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const res = await apiGet<ExposeResponse>(PATH, undefined, { timeoutMs: 10_000, quietStatuses: [404] });
      if (seq !== readSeq.current) return;
      apply(res);
      setLoadFailed(false);
    } catch (err) {
      if (seq !== readSeq.current) return;
      log.warn('settings', 'tunnel state read failed', { error: String(err) });
      setLoadFailed(true);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  const interval = exposePollMs(data?.status ?? null);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) void load(); }, interval);
    return () => clearInterval(timer);
  }, [interval, load]);

  // A written change answers with the new state; the next poll fills in the rest. `optionKey` names the
  // option a save is for: it stays marked as being edited until the write succeeds, so a refused value
  // (400) is still in its box after the reload below, where the person can fix it instead of retyping it.
  // A success drops the mark only while the box still holds what was saved (the host form does the same).
  // A refusal stays under its option until that option saves; a write of anything else leaves it be.
  const write = async (body: { enabled?: boolean; provider?: string; options?: Record<string, string>; run_on?: string | null }, optionKey?: string) => {
    setBusy(true);
    setError(null);
    readSeq.current++;
    try {
      const res = await apiPut<{ status: ExposeStatus }>(PATH, body);
      if (optionKey) {
        if ((typed.current[optionKey] ?? '') === (body.options?.[optionKey] ?? '')) editing.current.delete(optionKey);
        setOptionError(optionKey, null);
      }
      setData((prev) => {
        if (!prev) return prev;
        const { run_on: runOn, ...rest } = body;
        const placed = runOn !== undefined && runOn !== null ? { runOn, placedOn: runOn } : {};
        return { ...prev, status: res.status, settings: { ...prev.settings, ...rest, ...placed, options: body.options ?? prev.settings.options } as ExposeResponse['settings'] };
      });
      void load();
    } catch (err) {
      log.warn('settings', 'tunnel setting not saved', { error: saveErrorMessage(err) });
      if (optionKey) setOptionError(optionKey, saveErrorMessage(err));
      else setError(saveErrorMessage(err));
      void load();
    } finally {
      setBusy(false);
    }
  };

  // "Connect <host> first": the person's yes for an always-on host found in ~/.ssh/config
  // (src/core/hosts/found-hosts.ts), after which it is a place like the others.
  const [connecting, setConnecting] = useState<string | null>(null);
  const connectFound = async (host: string) => {
    setConnecting(host);
    setError(null);
    try {
      await answerFoundHost(host, 'yes');
    } catch (err) {
      setError(saveErrorMessage(err));
    } finally {
      setConnecting(null);
      void load();
    }
  };

  const retry = async () => {
    try {
      const res = await apiPost<{ status: ExposeStatus }>(`${PATH}/retry`);
      setData((prev) => (prev ? { ...prev, status: res.status } : prev));
    } catch (err) {
      setError(saveErrorMessage(err));
    }
  };

  const makeCode = async (url: string) => {
    setCodeError(null);
    try {
      const res = await apiPost<{ code: string; expiresAt: number; link?: string; url?: string; addresses?: SignInAddress[] }>('/api/devices/browser-code');
      // An older server answers with one link and no list.
      const addresses = res.addresses ?? (res.link && res.url ? [{ where: 'this-computer', label: 'This computer', url: res.url, link: res.link, alwaysOn: false }] : []);
      // The one the phone should use: an always-on host's first (it answers while this computer sleeps).
      const ordered = [...addresses.filter((a) => a.alwaysOn), ...addresses.filter((a) => !a.alwaysOn)];
      setCode({ code: res.code, expiresAt: res.expiresAt, addresses: ordered, url });
    } catch (err) {
      setCodeError(saveErrorMessage(err));
      // Refused (not the person at this computer): asking again would only be refused again.
      if (!(err instanceof Error && 'status' in err && (err as { status?: number }).status === 403)) {
        setTimeout(() => setCodeError(null), 30_000);
      }
    }
  };

  // A code is good for ten minutes: drop it from the screen when it runs out.
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(1_000, code.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [code, setCode]);

  // The phone link is there by itself once the tunnel answers (nothing to press). A fresh one
  // replaces it when it runs out, when a phone signed in with it (the server says so), and when
  // the address changed; none while the tunnel is down. A connected tunnel whose host has no
  // address to give yet is asked again a few seconds later.
  const tunnelUrl = !deviceCaller && data?.status.state === 'connected' ? data.status.url ?? null : null;
  const linkReady = tunnelUrl !== null;
  const minting = useRef(false);
  const mint = useCallback((url: string) => {
    if (minting.current) return;
    minting.current = true;
    void makeCode(url).finally(() => { minting.current = false; });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Only once the state is read: before that the address is not known, and the kept link stays.
    if (data && code && code.url !== tunnelUrl) { setCode(null); return; }
    if (tunnelUrl && !code && !codeError) mint(tunnelUrl);
  }, [data, tunnelUrl, code, codeError, mint, setCode]);
  // A few tries 5, 15 and 45 s apart, then the code to type stays until it runs out: each new link
  // takes one of the five live codes, and one already sent to a phone must not be pushed out.
  const emptyTries = useRef(0);
  useEffect(() => {
    if (!code) return;
    if (code.addresses.length > 0) { emptyTries.current = 0; return; }
    if (emptyTries.current >= 3) return;
    const timer = setTimeout(() => { emptyTries.current += 1; setCode(null); }, 5_000 * 3 ** emptyTries.current);
    return () => clearTimeout(timer);
  }, [code, setCode]);
  // Its link is used up: a new one for the next phone, and a line saying the sign-in worked.
  const [signedIn, setSignedIn] = useState<{ who: 'browser' | 'extension'; at: number } | null>(null);
  useEvent(BROWSER_SIGNED_IN_EVENT, (data) => {
    setCode(null);
    const name = (data as { name?: unknown } | null)?.name;
    setSignedIn({ who: typeof name === 'string' && name.startsWith('extension-') ? 'extension' : 'browser', at: Date.now() });
  });
  useEffect(() => {
    if (signedIn === null) return;
    const timer = setTimeout(() => setSignedIn(null), SIGNED_IN_NOTE_MS);
    return () => clearTimeout(timer);
  }, [signedIn]);
  // The QR of the link on screen, looked up by that link: while one is drawn for a new link, the
  // old link's QR never shows.
  const [, setQrDrawn] = useState(0);
  const phoneLink = code?.addresses[0]?.link;
  useEffect(() => {
    if (!phoneLink || drawnQr.has(phoneLink)) return;
    let live = true;
    void phoneLinkQr(phoneLink).then((data) => {
      if (!data) { log.warn('browser-access', 'the phone link QR code could not be drawn'); return; }
      drawnQr.set(phoneLink, data);
      if (drawnQr.size > 4) drawnQr.delete(drawnQr.keys().next().value!);
      if (live) setQrDrawn((n) => n + 1);
    });
    return () => { live = false; };
  }, [phoneLink]);

  if (!data) {
    return (
      <SettingsGroup heading={heading} data-testid="browser-access">
        <SettingsEmpty>{loadFailed ? "Couldn't read the tunnel state." : 'Loading...'}</SettingsEmpty>
      </SettingsGroup>
    );
  }

  const { status, providers, settings } = data;
  const allPlaces = data.places ?? [];
  // A found host waiting for the yes is offered as "Connect <host> first", never picked directly.
  const places = allPlaces.filter((p) => !p.needsConnect);
  const toConnect = allPlaces.filter((p) => p.needsConnect);
  const placedOn = settings.placedOn ?? 'here';
  const placedHost = places.find((p) => p.id === placedOn && p.id !== 'here');
  const providerId = settings.provider ?? providers[0]?.id ?? null;
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const line = describeExpose(status, provider?.title ?? 'the tunnel');
  const saveOption = (key: string) => {
    const value = options[key] ?? '';
    if ((settings.options[key] ?? '') === value) {
      // Put back as stored: nothing to write, and nothing refused any more.
      editing.current.delete(key);
      setOptionError(key, null);
      return;
    }
    void write({ options: { ...settings.options, [key]: value } }, key);
  };

  return (
    <SettingsGroup heading={heading} data-testid="browser-access">
      {providers.length === 0 ? (
        <SettingsRow
          label="Tunnel"
          help="No tunnel is set up; add a tunnel plugin, or set expose.command in config.yaml."
          data-testid="browser-access-no-provider"
        />
      ) : (
        <>
          {providers.length > 1 && (
            <SettingsRow
              label="Tunnel"
              help={provider?.description}
              control={
                <SegmentedControl
                  aria-label="Tunnel"
                  value={providerId ?? ''}
                  disabled={busy}
                  onChange={(v) => { void write({ provider: v }); }}
                  options={providers.map((p) => ({ value: p.id, label: p.title, testId: `browser-access-provider-${p.id}` }))}
                />
              }
            />
          )}
          {/* An option the provider fills itself asks the person nothing, unless a value saved
              before no longer fits it (then only the person can fix it). */}
          {(provider?.options ?? []).filter((option) => !option.hidden || !optionFits(option, settings.options[option.key])).map((option) => (
            <SettingsRow
              key={option.key}
              label={option.label}
              htmlFor={`browser-access-option-${option.key}`}
              help={option.help}
              error={optionErrors[option.key]}
              control={
                <input
                  id={`browser-access-option-${option.key}`}
                  type="text"
                  data-no-draft="autosave"
                  className="settings-input settings-input--short"
                  value={options[option.key] ?? ''}
                  placeholder={option.default}
                  spellCheck={false}
                  data-testid={`browser-access-option-${option.key}`}
                  onChange={(e) => {
                    editing.current.add(option.key);
                    const value = e.target.value;
                    typed.current[option.key] = value;
                    setOptions((prev) => ({ ...prev, [option.key]: value }));
                  }}
                  onBlur={() => saveOption(option.key)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOption(option.key); } }}
                />
              }
            />
          ))}
          {allPlaces.length > 0 && (
            <SettingsRow
              label="Runs on"
              help={placedHost
                ? `${placedHost.label} stays on, so the address answers while this computer sleeps.`
                : toConnect.length > 0
                  ? `${toConnect[0].label} stays on, but Walnut found it in ~/.ssh/config and does not connect to it until you say so.`
                  : 'The address answers while this computer is awake.'}
              data-testid="browser-access-runs-on"
              control={
                <span className="settings-addons-inline">
                  {places.length > 1 && (
                    <SegmentedControl
                      aria-label="Runs on"
                      value={placedOn}
                      disabled={busy}
                      onChange={(v) => { if (v !== placedOn) void write({ run_on: v }); }}
                      options={places.map((p) => ({ value: p.id, label: p.label, testId: `browser-access-runs-on-${p.id}` }))}
                    />
                  )}
                  {toConnect.map((p) => (
                    <SettingsButton
                      key={p.id}
                      disabled={connecting !== null}
                      onClick={() => void connectFound(p.id)}
                      data-testid={`browser-access-connect-${p.id}`}
                    >
                      {connecting === p.id ? 'Connecting...' : `Connect ${p.label} first`}
                    </SettingsButton>
                  ))}
                </span>
              }
            />
          )}
          <SettingsRow
            label="Open from anywhere"
            htmlFor="browser-access-enabled"
            help={
              <span className="browser-access-state" data-state={status.enabled ? status.state : 'off'} data-testid="browser-access-state">
                <span className="browser-access-dot" data-dot={line.dot} aria-hidden="true" />
                <span>{line.text}</span>
              </span>
            }
            error={error ?? undefined}
            control={
              <span className="settings-addons-inline">
                {status.enabled && line.retry && (
                  <SettingsButton variant="text" onClick={() => { void retry(); }} data-testid="browser-access-retry">Retry</SettingsButton>
                )}
                <ToggleSwitch
                  id="browser-access-enabled"
                  aria-label="Open from anywhere"
                  checked={settings.enabled}
                  busy={busy}
                  data-testid="browser-access-enabled"
                  onChange={(v) => { void write({ enabled: v, ...(providerId ? { provider: providerId } : {}) }); }}
                />
              </span>
            }
          />
        </>
      )}
      {signedIn !== null && !deviceCaller && (
        <div data-testid="browser-access-signed-in-note">
          <SettingsNotice kind="success" role="status">
            {signedIn.who === 'extension'
              ? 'The Walnut extension just signed in with the code. The link below is a new one, for the next phone.'
              : 'A browser just signed in with the link; it is listed under Devices. The link below is a new one, for the next phone.'}
          </SettingsNotice>
        </div>
      )}
      {deviceCaller ? (
        <SettingsRow
          label="Open on your phone"
          help={<span data-testid="browser-access-codes-elsewhere">The phone link shows on the computer Walnut runs on.</span>}
        />
      ) : (() => {
        const address = code?.addresses[0];
        const until = code ? new Date(code.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        const qrData = address ? drawnQr.get(address.link) : undefined;
        return (
          <SettingsRow
            label="Open on your phone"
            data-testid="browser-access-code"
            help={!linkReady
              ? 'The link shows here once the tunnel is connected.'
              : !code
                ? (codeError ? undefined : 'Making the link...')
                : !address
                  ? <>No address reaches this computer from outside yet. Meanwhile, type <span className="browser-access-code-inline settings-addons-mono" data-testid="browser-access-code-value">{code.code}</span> into Walnut on the other device; it works until {until}.</>
                  : (
                    <span className="browser-access-phone">
                      {qrData && (
                        <img
                          className="browser-access-qr"
                          src={qrData}
                          alt="QR code that opens Walnut on the phone, signed in"
                          width={PHONE_LINK_QR_SHOWN}
                          height={PHONE_LINK_QR_SHOWN}
                          data-for={address.link}
                          data-testid="browser-access-qr"
                        />
                      )}
                      <span className="browser-access-phone-text">
                        <a
                          className="settings-addons-link settings-addons-mono browser-access-link"
                          href={address.link}
                          title="Click to copy. Open it on the phone, not here: opening it here signs this browser in and uses the link up."
                          onClick={(e) => { e.preventDefault(); void copyTextRobust(address.link); }}
                          onAuxClick={(e) => e.preventDefault()}
                          data-testid="browser-access-link"
                        >{maskedLink(address.link)}</a>
                        <span className="browser-access-link-note">{`Scan the QR code with the phone's camera, or copy the link to the phone and open it there, not on this computer. It works once, for one phone, until ${until}.`}</span>
                        <span className="browser-access-link-note" data-testid="browser-access-typed">
                          {revealedFor === code.code ? (
                            <>
                              {'Type '}
                              <span className="browser-access-code-inline settings-addons-mono" data-testid="browser-access-revealed-code">{code.code}</span>
                              {' on the phone\'s sign-in screen. '}
                              <button type="button" className="settings-addons-link browser-access-reveal" onClick={() => setRevealedFor(null)} data-testid="browser-access-hide-code">Hide</button>
                            </>
                          ) : (
                            <>
                              {'No camera? '}
                              <button type="button" className="settings-addons-link browser-access-reveal" onClick={() => setRevealedFor(code.code)} data-testid="browser-access-reveal-code">Show the code to type</button>
                            </>
                          )}
                        </span>
                      </span>
                    </span>
                  )}
            error={codeError ?? undefined}
            control={address && linkReady ? <CopyButton text={address.link} data-testid="browser-access-copy-link" /> : undefined}
          />
        );
      })()}
      {/* Where the phones this link signed in are, and signed out: one step from here. */}
      {!deviceCaller && (
        <SettingsRow
          label="Signed-in browsers"
          help="Listed under Devices, where each one can be signed out."
          data-testid="browser-access-signed-in-row"
          control={(
            <a className="settings-button settings-button-default" href={`#${DEVICES_TAB}`} data-testid="browser-access-devices-link">
              <span className="settings-button-stack"><span className="settings-button-label">Devices</span></span>
            </a>
          )}
        />
      )}
    </SettingsGroup>
  );
}
