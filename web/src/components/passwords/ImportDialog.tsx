/**
 * Import from another password manager: pick the exported file, review what Walnut
 * found (a dry run on the server), then import. The file's text stays in this dialog's
 * memory only and is dropped when it closes.
 */
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalOverlay } from '@/hooks/useModalOverlay'
import { vaultApi, VaultApiError, type ImportReport } from '@/api/vault'
import { IMPORT_FORMATS } from '../../../../src/core/vault/import'
import { ImportIcon, CloseIcon } from './pw-icons'

const MAX_FILE_BYTES = 12 * 1024 * 1024

export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported: (added: number) => void }) {
  useModalOverlay(onClose)
  const file = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [format, setFormat] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [added, setAdded] = useState<number | null>(null)

  const review = async (t: string, n: string, f: string) => {
    setBusy(true); setError(''); setReport(null)
    try {
      const r = await vaultApi.importFile(t, n, true, f || undefined)
      setReport(r.report)
      if (!f) setFormat(r.report.format)
    } catch (err) {
      setError(err instanceof VaultApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = async (f: File | undefined) => {
    if (!f) return
    if (f.size > MAX_FILE_BYTES) { setError('That file is larger than 12 MB.'); return }
    const t = await f.text()
    setText(t); setName(f.name); setFormat(''); setAdded(null)
    await review(t, f.name, '')
  }

  const go = async () => {
    setBusy(true); setError('')
    try {
      const r = await vaultApi.importFile(text, name, false, format || undefined)
      setAdded(r.added ?? 0)
      setText('')
      onImported(r.added ?? 0)
    } catch (err) {
      setError(err instanceof VaultApiError ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="app-modal-overlay pw-modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pw-modal" role="dialog" aria-modal="true" aria-label="Import passwords" data-testid="pw-import">
        <div className="pw-modal-head">
          <h2>Import passwords</h2>
          <button type="button" className="pw-icon-btn" aria-label="Close" onClick={onClose}><CloseIcon /></button>
        </div>
        {added !== null ? (
          <div className="pw-modal-body">
            <p className="pw-import-done">Imported {added} item{added === 1 ? '' : 's'}.</p>
            <p className="pw-hint">Delete the exported file now: it holds every password in plain text.</p>
            <div className="pw-modal-actions"><button type="button" className="pw-btn pw-btn-primary" onClick={onClose}>Done</button></div>
          </div>
        ) : (
          <div className="pw-modal-body">
            <p className="pw-hint">Export from Bitwarden (.json or .csv), 1Password (.csv), Apple Passwords (.csv), Chrome or Firefox (.csv), then pick the file. Nothing is added until you confirm.</p>
            <input ref={file} type="file" accept=".csv,.json,text/csv,application/json" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = '' }} data-testid="pw-import-file" />
            <button type="button" className="pw-drop" onClick={() => file.current?.click()}>
              <ImportIcon size={22} />
              <span>{name || 'Choose an exported file'}</span>
            </button>
            {text && (
              <div className="pw-seg pw-seg-wrap" role="radiogroup" aria-label="Format">
                {Object.entries(IMPORT_FORMATS).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={format === id} className={format === id ? 'on' : ''} onClick={() => { setFormat(id); void review(text, name, id) }}>{label}</button>
                ))}
              </div>
            )}
            {busy && <p className="pw-hint">Reading…</p>}
            {error && <p className="pw-hint pw-hint-bad" role="alert">{error}</p>}
            {report && (
              <div className="pw-import-report" data-testid="pw-import-report">
                <div className="pw-import-stats">
                  <div><b>{report.toAdd}</b><span>to add</span></div>
                  <div><b>{report.duplicates}</b><span>already here</span></div>
                  <div><b>{report.skipped.length}</b><span>skipped</span></div>
                  {report.passkeys > 0 && <div><b>{report.passkeys}</b><span>passkeys kept</span></div>}
                </div>
                {report.skipped.length > 0 && (
                  <details className="pw-import-skipped">
                    <summary>Why some were skipped</summary>
                    <ul>{report.skipped.slice(0, 50).map((s) => <li key={s.row}>Row {s.row}{s.title ? ` (${s.title})` : ''}: {s.reason}</li>)}</ul>
                  </details>
                )}
              </div>
            )}
            <div className="pw-modal-actions">
              <button type="button" className="pw-btn" onClick={onClose}>Cancel</button>
              <button type="button" className="pw-btn pw-btn-primary" disabled={!report || report.toAdd === 0 || busy} onClick={() => void go()}>
                Import {report?.toAdd ? `${report.toAdd} item${report.toAdd === 1 ? '' : 's'}` : ''}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
