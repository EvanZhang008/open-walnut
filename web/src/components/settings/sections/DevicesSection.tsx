import { useState, useEffect, useCallback } from 'react';
import { SectionCard } from '../inputs/SectionCard';
import { apiGet, apiDelete } from '@/api/client';
import { log } from '@/utils/log';
import { PairingQrBlock } from './cloud/PairingQrBlock';
import { usePairDevice, type PairingTarget, type PairTargetKind } from './cloud/usePairDevice';

/** Self-reported hardware identity — absent until the phone checks in once. */
interface DeviceSelfInfo {
  model?: string;
  os?: string;
  deviceName?: string;
  appVersion?: string;
  reportedAt?: string;
}

interface DeviceEntry {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** What this credential actually is — not everything in the list is a phone. */
  role?: 'phone' | 'simulator' | 'self';
  info?: DeviceSelfInfo;
}

/** "iPhone17,1 · iOS 26.1 · Walnut 1.0 (26)" — omits whatever wasn't reported. */
function describeDevice(info?: DeviceSelfInfo): string | null {
  if (!info) return null;
  const parts = [info.model, info.os, info.appVersion ? `Walnut ${info.appVersion}` : undefined]
    .filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(' · ') : null;
}

const ROLE_NOTE: Record<'simulator' | 'self', string> = {
  self: 'This computer — used for cloud sync. Not a phone; revoking it breaks sync.',
  simulator: 'iOS Simulator on this computer (development).',
};

/**
 * Where a scanned QR points the phone. `cloud` works off Wi-Fi. Defined in
 * cloud/usePairDevice.ts — the Cloud Companion section pairs the same way.
 */
type TargetKind = PairTargetKind;

/** Re-pair via cloud when the device has one — it keeps working off Wi-Fi. */
function preferredKind(kinds: TargetKind[]): TargetKind {
  return kinds.includes('cloud') ? 'cloud' : 'lan';
}

/**
 * Paired devices (iOS app etc.) — list, revoke, and pair a new device by
 * showing a wn://pair QR code the Walnut iOS app scans. The token appears
 * exactly once (only its hash is stored server-side), so the QR block stays
 * visible until dismissed.
 *
 * Two pairing targets, because they are genuinely different credentials:
 * "This network" mints locally (same Wi-Fi only) and "Cloud" mints on the
 * cloud companion (works anywhere). Picking the wrong one is the classic
 * failure — a LAN QR scanned over cellular can never connect.
 */
export function DevicesSection() {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [cloudDevices, setCloudDevices] = useState<DeviceEntry[]>([]);
  const [targets, setTargets] = useState<PairingTarget[]>([]);
  const [target, setTarget] = useState<TargetKind>('lan');
  const [newName, setNewName] = useState('');
  // Minting + QR rendering is shared with the Cloud Companion section.
  const { created, qrDataURL, error, busy, mint, dismiss, setError } = usePairDevice();

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ devices: DeviceEntry[]; cloudDevices?: DeviceEntry[]; targets?: PairingTarget[] }>(
        '/api/devices',
      );
      setDevices(res.devices);
      setCloudDevices(res.cloudDevices ?? []);
      const list = res.targets ?? [];
      setTargets(list);
      // Default to Cloud when it exists — a phone that leaves the house keeps
      // working, which is what people mean by "connect my phone".
      setTarget((prev) => (list.some((t) => t.kind === prev) ? prev : (list[list.length - 1]?.kind ?? 'lan')));
    } catch (err) {
      log.error('settings', 'devices list failed', { error: String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Re-pair an existing device: mint a FRESH token for the same name and show
   * the QR again. Needed because tokens are one-time — after an app reinstall
   * iOS wipes UserDefaults (server URL + device name), so the phone has to be
   * re-paired, and there is nothing to "show again". Rotating in place beats
   * making the user Revoke-then-Add by hand.
   */
  const repair = async (name: string, kind: TargetKind) => {
    if (busy) return;
    if (!window.confirm(
      `Show a new QR code for "${name}"?\n\nIts current token stops working immediately — scan the new code on that phone.`,
    )) return;
    // Keep the picker on the device's OWN target — re-pairing a cloud phone
    // must not silently flip the UI back to the Wi-Fi default.
    setTarget(kind);
    if (await mint({ name, target: kind, replace: true })) await refresh();
  };

  const addDevice = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    // Only send an explicit target when one was actually offered — otherwise
    // let the server pick (it falls back to a token-only QR).
    const chosen = targets.some((t) => t.kind === target) ? target : undefined;
    if (await mint({ name, target: chosen })) {
      setNewName('');
      await refresh();
    }
  };

  /**
   * Revoke EVERY credential behind a row. A phone paired to both this Mac and
   * the cloud has two tokens; killing one and leaving the other would still let
   * the device in, so "Revoke" must mean revoked.
   */
  const revoke = async (name: string, kinds: TargetKind[]) => {
    if (!window.confirm(`Revoke "${name}"? The device will be signed out.`)) return;
    try {
      for (const kind of kinds) {
        await apiDelete(`/api/devices/${encodeURIComponent(name)}${kind === 'cloud' ? '?target=cloud' : ''}`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const activeTarget = targets.find((t) => t.kind === target);
  // ONE row per physical device. The same phone is usually paired to both this
  // Mac and the cloud, and listing each credential separately showed the same
  // name twice — indistinguishable rows that made a 2-device setup look like 9.
  // Merge by name, keep both badges, and act on the credential that matches the
  // button the user pressed.
  const rows = (() => {
    const byName = new Map<string, DeviceEntry & { kinds: TargetKind[] }>();
    const add = (d: DeviceEntry, kind: TargetKind) => {
      const existing = byName.get(d.name);
      if (existing) {
        existing.kinds.push(kind);
        // Show the most recent activity across both credentials.
        if (d.lastUsedAt && (!existing.lastUsedAt || d.lastUsedAt > existing.lastUsedAt)) {
          existing.lastUsedAt = d.lastUsedAt;
        }
        return;
      }
      byName.set(d.name, { ...d, kinds: [kind] });
    };
    devices.forEach((d) => add(d, 'lan'));
    cloudDevices.forEach((d) => add(d, 'cloud'));
    // Real phones first — the row the user came here for shouldn't sit under
    // this Mac's own sync credential.
    const rank = (r?: string) => (r === 'phone' || !r ? 0 : r === 'simulator' ? 1 : 2);
    return [...byName.values()].sort((a, b) => rank(a.role) - rank(b.role));
  })();
  const phones = rows.filter((r) => (r.role ?? 'phone') === 'phone');
  const others = rows.filter((r) => (r.role ?? 'phone') !== 'phone');

  return (
    <SectionCard
      id="devices"
      title="Devices"
      description="Your phones running the Walnut iOS app. Pair one by scanning a QR code — tokens are shown once and stored hashed."
    >
      <div className="devices-section">
        {(() => {
          const renderRow = (d: typeof rows[number]) => {
            const role = d.role ?? 'phone';
            return (
              <li key={d.name} className="devices-row">
                <div className="devices-row-main">
                  <span className="devices-name">
                    {d.name}
                    {d.kinds.map((k) => (
                      <span key={k} className={`devices-tag devices-tag-${k}`}>
                        {k === 'cloud' ? 'Cloud' : 'Local'}
                      </span>
                    ))}
                  </span>
                  {role === 'phone' && describeDevice(d.info) && (
                    <span className="devices-hw">{describeDevice(d.info)}</span>
                  )}
                  <span className="devices-meta">
                    {role === 'phone'
                      ? `paired ${new Date(d.createdAt).toLocaleDateString()}${d.lastUsedAt ? ` · last used ${new Date(d.lastUsedAt).toLocaleDateString()}` : ''}`
                      : ROLE_NOTE[role]}
                  </span>
                  {role === 'phone' && !d.info && (
                    <span className="devices-meta devices-meta-dim">
                      Model unknown — open the app on this phone to fill it in
                    </span>
                  )}
                </div>
                <div className="devices-row-actions">
                  {role === 'phone' && (
                    <button
                      type="button"
                      className="devices-showqr"
                      disabled={busy}
                      title="Mint a new token and show its QR code — for a phone that lost its pairing"
                      onClick={() => void repair(d.name, preferredKind(d.kinds))}
                    >
                      Show QR
                    </button>
                  )}
                  {/* This Mac's own sync credential has no QR and must not be
                      casually revoked — that silently breaks cloud sync. */}
                  {role !== 'self' && (
                    <button
                      type="button"
                      className="btn-danger-outline"
                      onClick={() => void revoke(d.name, d.kinds)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              </li>
            );
          };
          return (
            <>
              {phones.length > 0 && <ul className="devices-list">{phones.map(renderRow)}</ul>}
              {phones.length === 0 && rows.length > 0 && (
                <p className="devices-hint">No phones paired yet — pair one below.</p>
              )}
              {others.length > 0 && (
                <details className="devices-others">
                  <summary>{others.length} non-phone {others.length === 1 ? 'entry' : 'entries'} (this computer, simulators)</summary>
                  <ul className="devices-list">{others.map(renderRow)}</ul>
                </details>
              )}
            </>
          );
        })()}

        {targets.length > 1 && (
          <div className="devices-target-row" role="radiogroup" aria-label="Pairing target">
            {targets.map((t) => (
              <button
                key={t.kind}
                type="button"
                role="radio"
                aria-checked={target === t.kind}
                className={`devices-target${target === t.kind ? ' devices-target-active' : ''}`}
                onClick={() => setTarget(t.kind)}
              >
                <span className="devices-target-label">{t.label}</span>
                <span className="devices-target-origin">{t.origin.replace(/^https?:\/\//, '')}</span>
              </button>
            ))}
          </div>
        )}

        {targets.length === 0 && (
          <p className="devices-hint">
            No auto-detectable address for this machine — the QR will carry only the token, so
            you'll type the server address in the app. For one-tap pairing from anywhere,{' '}
            <a
              href="#cloud"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById('cloud')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            >
              set up a cloud companion
            </a>.
          </p>
        )}

        <div className="devices-add-row">
          <input
            type="text"
            value={newName}
            placeholder="Device name (e.g. iPhone)"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addDevice(); } }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !newName.trim()}
            onClick={() => void addDevice()}
          >
            {busy ? 'Pairing…' : 'Pair new device'}
          </button>
        </div>

        {activeTarget && (
          <p className="devices-hint">
            {activeTarget.kind === 'cloud'
              ? 'Cloud pairing works from anywhere, including cellular. The token is created on your cloud companion.'
              : 'This QR only works while the phone is on the same Wi-Fi as this Mac.'}
          </p>
        )}

        {error && <p className="devices-error">{error}</p>}

        {created && qrDataURL && (
          <PairingQrBlock created={created} qrDataURL={qrDataURL} onDismiss={dismiss} />
        )}
      </div>
    </SectionCard>
  );
}
