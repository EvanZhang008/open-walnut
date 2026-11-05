/**
 * Settings, Sessions: "Import from Claude Code" for each engine that offers it (pi).
 *
 * One click shows what the import brings to the chosen host (credentials by name,
 * MCP servers, skills, instructions, the engine settings it changes) and what
 * cannot carry over with the nearest alternative; Import writes it. Claude Code's
 * own files are only read (src/core/agents/claude-code-import.ts). Nothing here
 * writes Walnut's config.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useAllHostStatus } from '@/hooks/useHostStatus';
import { useHostDisplayLabels } from '@/hooks/useHostDisplayLabel';
import { LOCAL_HOST } from '@/api/engine-settings';
import {
  applyClaudeCodeImport, fetchClaudeCodeImport,
  type ClaudeCodeImportItem, type ClaudeCodeImportPreview,
} from '@/api/claude-code-import';
import { log } from '@/utils/log';
import { gatewayChangeLine, importSummaryLine, settingValueText } from './claude-code-import-text';
import '@/styles/claude-code-import.css';

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'preview'; preview: ClaudeCodeImportPreview; written?: string[] }
  | { kind: 'applying'; preview: ClaudeCodeImportPreview }
  | { kind: 'error'; message: string; preview?: ClaudeCodeImportPreview };

export function ClaudeCodeImportGroups() {
  const catalog = useEngineCatalog();
  const engines = catalog.filter((e) => e.capabilities.claudeCodeImport === true);
  return <>{engines.map((e) => <ClaudeCodeImportGroup key={e.id} engine={e.id} name={e.displayName} />)}</>;
}

function ClaudeCodeImportGroup({ engine, name }: { engine: string; name: string }) {
  const hostStatus = useAllHostStatus();
  const labelOf = useHostDisplayLabels();
  const hosts = useMemo(
    () => [LOCAL_HOST, ...hostStatus.filter((h) => h.connected && h.host !== LOCAL_HOST).map((h) => h.host)],
    [hostStatus],
  );
  const [host, setHost] = useState(LOCAL_HOST);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // A late answer for a host the user already left never paints.
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const review = useCallback(async (target: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const gen = ++generation.current;
    setPhase({ kind: 'loading' });
    try {
      const preview = await fetchClaudeCodeImport(engine, target, ctrl.signal);
      if (gen === generation.current) setPhase({ kind: 'preview', preview });
    } catch (err) {
      if (gen !== generation.current || ctrl.signal.aborted) return;
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [engine]);

  const pickHost = (next: string) => {
    setHost(next);
    if (phase.kind !== 'idle') void review(next);
  };

  const apply = async (preview: ClaudeCodeImportPreview) => {
    const gen = ++generation.current;
    setPhase({ kind: 'applying', preview });
    try {
      const result = await applyClaudeCodeImport(engine, host);
      log.info('settings', 'claude code import applied', { engine, host, written: result.written.length });
      if (gen === generation.current) setPhase({ kind: 'preview', preview: result.preview, written: result.written });
    } catch (err) {
      if (gen !== generation.current) return;
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err), preview });
    }
  };

  const hostPicker = hosts.length > 1 ? (
    <select
      className="settings-select"
      aria-label="Host to import on"
      data-testid={`cc-import-host-${engine}`}
      value={host}
      onChange={(e) => pickHost(e.target.value)}
    >
      {hosts.map((h) => <option key={h} value={h}>{h === LOCAL_HOST ? 'This machine' : labelOf(h)}</option>)}
    </select>
  ) : null;
  const busy = phase.kind === 'loading' || phase.kind === 'applying';
  const shown = phase.kind === 'preview' || phase.kind === 'applying' ? phase.preview : phase.kind === 'error' ? phase.preview : undefined;

  return (
    <SettingsGroup heading={name} data-testid={`cc-import-group-${engine}`}>
      <SettingsRow
        label="Import from Claude Code"
        help={`Use your Claude Code setup in ${name}: the same model provider and credentials, MCP servers, skills and instructions. Claude Code's files are only read.`}
        control={(
          <span className="cc-import-controls">
            {hostPicker}
            <button
              type="button"
              className="settings-button settings-button-default"
              data-testid={`cc-import-review-${engine}`}
              disabled={busy}
              onClick={() => void review(host)}
            >
              {phase.kind === 'loading' ? 'Reading…' : phase.kind === 'idle' ? 'Review…' : 'Check again'}
            </button>
          </span>
        )}
        error={phase.kind === 'error' ? <span data-testid={`cc-import-error-${engine}`}>{phase.message}</span> : undefined}
      />
      {shown && (
        <ImportPreviewRows
          engine={engine}
          name={name}
          preview={shown}
          written={phase.kind === 'preview' ? phase.written : undefined}
          applying={phase.kind === 'applying'}
          onApply={() => void apply(shown)}
        />
      )}
    </SettingsGroup>
  );
}

function ItemList({ items, testId }: { items: ClaudeCodeImportItem[]; testId: string }) {
  return (
    <ul className="cc-import-list" data-testid={testId}>
      {items.map((i) => (
        <li key={`${i.source}:${i.name}`}>
          <span className="cc-import-name">{i.name}</span>
          {i.detail && i.detail !== i.name && <span className="cc-import-detail"> {i.detail}</span>}
          {i.source !== 'user' && <span className="cc-import-source"> ({i.source})</span>}
        </li>
      ))}
    </ul>
  );
}

function ImportPreviewRows({ engine, name, preview, written, applying, onApply }: {
  engine: string; name: string; preview: ClaudeCodeImportPreview; written?: string[]; applying: boolean; onApply: () => void;
}) {
  if (!preview.claudeCode.found) {
    return (
      <SettingsRow indent label="Claude Code not found" data-testid={`cc-import-none-${engine}`}
        help={`There is no ${preview.claudeCode.settingsPath} on this host, so there is nothing to import. Set ${name} up on its own, or install and sign in to Claude Code first.`} />
    );
  }
  const gatewayUnreadable = preview.gateway?.unreadable;
  const blocked = preview.extension.state === 'foreign' || preview.settings.unreadable !== undefined || gatewayUnreadable !== undefined;
  return (
    <>
      <SettingsRow indent label="Summary" data-testid={`cc-import-summary-${engine}`} help={importSummaryLine(preview, name)} />
      {(preview.warnings ?? []).length > 0 && (
        <SettingsRow indent state="warning" label="Not everything could be read" data-testid={`cc-import-warnings-${engine}`}
          help={(preview.warnings ?? []).join(' ')} />
      )}
      {!preview.pi.installed && (
        <SettingsRow indent state="warning" label={`${name} is not installed on this host`}
          help={`The import can still be written now; ${name} uses it once installed.`} />
      )}
      {preview.pi.needsUpdateForMcp && (
        <SettingsRow indent state="warning" label={`Update ${name} for MCP servers`} data-testid={`cc-import-update-${engine}`}
          help={`${name} ${preview.pi.version} cannot run MCP servers; everything else comes over now. Update with: npm install -g @earendil-works/pi-coding-agent@latest`} />
      )}
      <SettingsRow indent label="Model and credentials" data-testid={`cc-import-credentials-${engine}`} help={preview.credentials.note}>
        {preview.credentials.vars.length > 0 && (
          <ul className="cc-import-list">
            {preview.credentials.vars.map((v) => (
              <li key={v.name}><span className="cc-import-name">{v.name}</span>{v.value !== undefined ? <span className="cc-import-detail"> = {v.value}</span> : <span className="cc-import-detail"> (secret, read in place)</span>}</li>
            ))}
          </ul>
        )}
        {preview.gateway && (
          <p className="cc-import-gateway" data-testid={`cc-import-gateway-${engine}`}>{gatewayChangeLine(preview, name)}</p>
        )}
        {preview.settings.changes.length > 0 && (
          <ul className="cc-import-list" data-testid={`cc-import-changes-${engine}`}>
            {preview.settings.changes.map((c) => (
              <li key={c.key}><span className="cc-import-name">{c.key}</span><span className="cc-import-detail"> {settingValueText(c.from)} → {settingValueText(c.to)}</span></li>
            ))}
          </ul>
        )}
      </SettingsRow>
      {preview.mcpServers.length > 0 && (
        <SettingsRow indent label={`MCP servers (${preview.mcpServers.length})`} help="Started by pi when a session needs one of their tools.">
          <ItemList items={preview.mcpServers} testId={`cc-import-mcp-${engine}`} />
        </SettingsRow>
      )}
      {preview.skippedMcpServers.length > 0 && (
        <SettingsRow indent label={`MCP servers left out (${preview.skippedMcpServers.length})`}>
          <ItemList items={preview.skippedMcpServers} testId={`cc-import-mcp-skipped-${engine}`} />
        </SettingsRow>
      )}
      {(preview.skills.length > 0 || preview.commands.length > 0) && (
        <SettingsRow indent label="Skills and commands">
          <ItemList items={[...preview.skills, ...preview.commands]} testId={`cc-import-skills-${engine}`} />
        </SettingsRow>
      )}
      {preview.instructions.length > 0 && (
        <SettingsRow indent label="Instructions" help="Read with each project's own CLAUDE.md files, as Claude Code reads them.">
          <ItemList items={preview.instructions} testId={`cc-import-instructions-${engine}`} />
        </SettingsRow>
      )}
      {preview.cannotCarry.length > 0 && (
        <SettingsRow indent label="Cannot carry over">
          <ul className="cc-import-list" data-testid={`cc-import-cannot-${engine}`}>
            {preview.cannotCarry.map((c) => (
              <li key={c.what}><span className="cc-import-name">{c.what}:</span><span className="cc-import-detail"> {c.why} Nearest: {c.nearest}</span></li>
            ))}
          </ul>
        </SettingsRow>
      )}
      <SettingsRow
        indent
        label={written ? 'Imported' : preview.upToDate ? 'Up to date' : 'Ready to import'}
        data-testid={`cc-import-apply-row-${engine}`}
        help={written
          ? (written.length > 0 ? `Wrote ${written.join(', ')}. New ${name} sessions use it.` : 'Nothing needed writing.')
          : preview.upToDate
            ? `${name} on this host already uses your Claude Code setup; it reads changes to Claude Code's files each time it starts.`
            : blocked
              ? (preview.settings.unreadable ?? gatewayUnreadable ?? `${preview.extension.path} is not Walnut's file; move it away to import.`)
              : preview.gateway && preview.gateway.change !== 'none'
                ? `Writes ${preview.extension.path}, the ${preview.gateway.provider} provider in ${preview.gateway.path} and the changed keys of ${preview.settings.path}.`
                : `Writes ${preview.extension.path} and the changed keys of ${preview.settings.path}.`}
        control={!written && !preview.upToDate ? (
          <button
            type="button"
            className="settings-button settings-button-primary"
            data-testid={`cc-import-apply-${engine}`}
            disabled={applying || blocked}
            onClick={onApply}
          >
            {applying ? 'Importing…' : 'Import'}
          </button>
        ) : undefined}
      />
    </>
  );
}
