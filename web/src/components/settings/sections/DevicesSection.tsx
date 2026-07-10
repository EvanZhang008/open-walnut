import { useState, useEffect, useCallback } from 'react';
import QRCode from 'qrcode';
import { SectionCard } from '../inputs/SectionCard';
import { apiGet, apiPost, apiDelete } from '@/api/client';
import { log } from '@/utils/log';

interface DeviceEntry {
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface CreatedDevice {
  name: string;
  token: string;
  pairingURI: string;
}

/**
 * Paired devices (iOS app etc.) — list, revoke, and pair a new device by
 * showing a wn://pair QR code the Walnut iOS app scans. The token appears
 * exactly once (only its hash is stored server-side), so the QR block stays
 * visible until dismissed.
 */
export function DevicesSection() {
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  const [newName, setNewName] = useState('');
  const [created, setCreated] = useState<CreatedDevice | null>(null);
  const [qrDataURL, setQrDataURL] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ devices: DeviceEntry[] }>('/api/devices');
      setDevices(res.devices);
    } catch (err) {
      log.error('settings', 'devices list failed', { error: String(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addDevice = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<CreatedDevice>('/api/devices', { name });
      setCreated(res);
      setNewName('');
      // High error correction — phones scan glossy screens at an angle.
      const dataURL = await QRCode.toDataURL(res.pairingURI, {
        errorCorrectionLevel: 'M',
        width: 260,
        margin: 2,
      });
      setQrDataURL(dataURL);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (name: string) => {
    if (!window.confirm(`Revoke "${name}"? The device will be signed out.`)) return;
    try {
      await apiDelete(`/api/devices/${encodeURIComponent(name)}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <SectionCard
      id="devices"
      title="Devices"
      description="Pair the Walnut iOS app by scanning a QR code. Tokens are shown once and stored hashed."
    >
      <div className="devices-section">
        {devices.length > 0 && (
          <ul className="devices-list">
            {devices.map((d) => (
              <li key={d.name} className="devices-row">
                <div className="devices-row-main">
                  <span className="devices-name">{d.name}</span>
                  <span className="devices-meta">
                    paired {new Date(d.createdAt).toLocaleDateString()}
                    {d.lastUsedAt ? ` · last used ${new Date(d.lastUsedAt).toLocaleDateString()}` : ''}
                  </span>
                </div>
                <button type="button" className="btn-danger-outline" onClick={() => void revoke(d.name)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="devices-add-row">
          <input
            type="text"
            value={newName}
            placeholder="Device name (e.g. iPhone)"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addDevice(); } }}
          />
          <button type="button" className="btn-primary" disabled={busy || !newName.trim()} onClick={() => void addDevice()}>
            {busy ? 'Pairing…' : 'Pair new device'}
          </button>
        </div>

        {error && <p className="devices-error">{error}</p>}

        {created && qrDataURL && (
          <div className="devices-qr-block">
            <img src={qrDataURL} alt={`Pairing QR code for ${created.name}`} width={260} height={260} />
            <p className="devices-qr-hint">
              Scan with the Walnut iOS app (Setup → Scan QR). Shown once — the
              server keeps only a hash.
            </p>
            <details>
              <summary>Manual token</summary>
              <code className="devices-token">{created.token}</code>
            </details>
            <button
              type="button"
              className="btn-primary"
              onClick={() => { setCreated(null); setQrDataURL(null); }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
