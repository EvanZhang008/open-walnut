/**
 * ReferencePanel — the "find references" side panel raised by cmd+clicking an
 * identifier in the Files viewer. Definitions listed first (they jump on
 * cmd+click directly when there's exactly one), every other occurrence below,
 * grouped by file. Clicking a row opens that file at that line in the SAME
 * preview pane (browser-style history handles the way back).
 */
import { useMemo } from 'react';
import type { ReferencesResponse, ReferenceMatch } from '@/api/files';

interface ReferencePanelProps {
  /** null = loading (the header still names the symbol). */
  result: ReferencesResponse | null;
  symbol: string;
  /** The file the lookup was made FROM — its group sorts first and is tinted,
   *  so "where am I" is answered before "where else". */
  currentFile?: string;
  loading: boolean;
  error: string | null;
  /** Jump to a match — open file at line. */
  onOpen: (file: string, line: number) => void;
  onClose: () => void;
}

interface FileGroup { file: string; rel: string; matches: ReferenceMatch[] }

function groupByFile(matches: ReferenceMatch[], root: string, currentFile?: string): FileGroup[] {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const byFile = new Map<string, ReferenceMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.file);
    if (list) list.push(m);
    else byFile.set(m.file, [m]);
  }
  const groups = [...byFile.entries()].map(([file, list]) => ({
    file,
    rel: file.startsWith(prefix) ? file.slice(prefix.length) : file,
    matches: list.sort((a, b) => a.line - b.line),
  }));
  // The file you clicked in comes first — it's the one you're looking at.
  if (currentFile) groups.sort((a, b) => Number(b.file === currentFile) - Number(a.file === currentFile));
  return groups;
}

/** Render one match line with the symbol occurrences emphasized. */
function MatchText({ text, symbol }: { text: string; symbol: string }) {
  const parts = useMemo(() => {
    const out: { s: string; hit: boolean }[] = [];
    let rest = text;
    let idx: number;
    while ((idx = rest.indexOf(symbol)) !== -1) {
      // Word-boundary check so `Sync` doesn't emphasize inside `HasSynced`.
      const before = idx === 0 ? '' : rest[idx - 1]!;
      const after = rest[idx + symbol.length] ?? '';
      const bounded = !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
      if (idx > 0) out.push({ s: rest.slice(0, idx), hit: false });
      out.push({ s: symbol, hit: bounded });
      rest = rest.slice(idx + symbol.length);
    }
    if (rest) out.push({ s: rest, hit: false });
    return out;
  }, [text, symbol]);
  return (
    <span className="ref-panel-text">
      {parts.map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}
    </span>
  );
}

export function ReferencePanel({ result, symbol, currentFile, loading, error, onOpen, onClose }: ReferencePanelProps) {
  // Keyed on `result` itself, not on the filtered arrays' lengths: two different
  // result sets can share a count, and regrouping ≤500 rows is trivial.
  const defGroups = useMemo(
    () => (result ? groupByFile(result.matches.filter((m) => m.kind === 'def'), result.root, currentFile) : []),
    [result, currentFile],
  );
  const refGroups = useMemo(
    () => (result ? groupByFile(result.matches.filter((m) => m.kind === 'ref'), result.root, currentFile) : []),
    [result, currentFile],
  );

  const renderGroups = (groups: FileGroup[]) => groups.map((g) => (
    <div key={g.file} className="ref-panel-file-group">
      <div
        className={`ref-panel-file${g.file === currentFile ? ' ref-panel-file-current' : ''}`}
        title={g.file}
      >
        {g.rel}
        {g.file === currentFile && <span className="ref-panel-current-tag">this file</span>}
      </div>
      {g.matches.map((m) => (
        <div
          key={`${m.file}:${m.line}`}
          className={`ref-panel-row${m.kind === 'def' ? ' ref-panel-def' : ''}`}
          onClick={() => onOpen(m.file, m.line)}
          title={`${m.file}:${m.line}`}
        >
          <span className="ref-panel-line">{m.line}</span>
          <MatchText text={m.text.trim()} symbol={symbol} />
        </div>
      ))}
    </div>
  ));

  return (
    <div className="ref-panel">
      <div className="ref-panel-header">
        <span className="ref-panel-title">
          References: <code>{symbol}</code>
          {result && !loading && (
            <span className="ref-panel-count">
              {result.matches.length}{result.truncated ? '+' : ''} in {new Set(result.matches.map((m) => m.file)).size} files
            </span>
          )}
        </span>
        <button type="button" className="ref-panel-close" onClick={onClose} title="Close (Esc)" aria-label="Close references">✕</button>
      </div>
      <div className="ref-panel-body">
        {loading && <div className="ref-panel-status">Searching…</div>}
        {!loading && error && <div className="ref-panel-status ref-panel-error">{error}</div>}
        {!loading && !error && result && result.matches.length === 0 && (
          <div className="ref-panel-status">No matches for <code>{symbol}</code>{result.error ? ` — ${result.error}` : ''}</div>
        )}
        {!loading && defGroups.length > 0 && (
          <>
            <div className="ref-panel-section">Definitions</div>
            {renderGroups(defGroups)}
          </>
        )}
        {!loading && refGroups.length > 0 && (
          <>
            <div className="ref-panel-section">References</div>
            {renderGroups(refGroups)}
          </>
        )}
        {!loading && result?.truncated && (
          <div className="ref-panel-status">Result capped — refine the symbol or search in a narrower repo.</div>
        )}
      </div>
    </div>
  );
}
