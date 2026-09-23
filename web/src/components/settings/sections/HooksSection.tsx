import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { fetchHooks, patchHook, type HookInfo, type HookSetting } from '@/api/hooks';
import {
  SettingsEmpty, SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow, SettingsSection, SettingsTag,
} from '../SettingsSection';
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch';
import { NumberInput } from '@/components/settings/inputs/NumberInput';
import { SettingsButton } from '@/components/settings/inputs/SettingsButton';
import { couldntSave } from '@/components/settings/inputs/useOptimisticSetting';
import { saveErrorMessage, useSettingsSaved } from '../settings-pane-context';
import { ChevronGlyph, CloseGlyph } from '../settings-glyphs';
import { hookDescription, hookHelp, hookNames } from './hook-text';
import { HOOK_COPY } from './hook-copy';
import { CodeText } from './code-text';
import { log } from '@/utils/log';

export type HookGroupKey = 'walnut' | 'daemon' | 'yours';


/** Which group a hook is listed in (pure, unit tested). */
export function hookGroupOf(h: Pick<HookInfo, 'runtime' | 'source'>): HookGroupKey {
  if (h.source === 'config' || h.source === 'file') return 'yours';
  return h.runtime === 'daemon' ? 'daemon' : 'walnut';
}

/** Name without the trailing `(event)`: the events are listed under Fires on. */
export function hookDisplayName(name: string): string {
  const stripped = name.replace(/\s*\([^)]*\)\s*$/, '');
  return stripped || name;
}

/** The tag after a hook's name. */
export function hookTag(h: Pick<HookInfo, 'source'>): string | null {
  if (h.source === 'builtin') return 'Built-in';
  if (h.source === 'daemon-policy') return 'Daemon policy';
  // Inline hooks are built into Walnut's session code: the same thing to a user.
  if (h.source === 'inline') return 'Built-in';
  return null;
}

/**
 * A tag only tells rows apart: when every hook in a group carries the same
 * one, the group heading already says it and the rows show none (N3-11). Pure.
 */
export function groupShowsTags(hooks: Array<Pick<HookInfo, 'source'>>): boolean {
  return new Set(hooks.map((h) => hookTag(h))).size > 1;
}

const GROUPS: Array<{ key: HookGroupKey; title: string; footer: string }> = [
  { key: 'walnut', title: 'Walnut hooks', footer: 'Run on session, task and cron events.' },
  { key: 'daemon', title: 'Daemon hooks', footer: 'Run inside the session daemon on each host.' },
  { key: 'yours', title: 'Your hooks', footer: '' },
];

/**
 * Editable knobs a hook declares (HookInfo.settings), as indent rows. Commits
 * on blur / Enter rather than per keystroke: each write hits config.yaml and
 * (for daemon policies) is announced as "needs a daemon restart".
 */
function HookSettingRows({
  hook, onCommit,
}: {
  hook: HookInfo;
  onCommit: (h: HookInfo, key: string, value: number | boolean) => void;
}) {
  const settings = hook.settings ?? [];
  // Local draft so typing isn't fought by the server value mid-edit.
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  useEffect(() => { setDraft({}); }, [hook.settings]);
  if (settings.length === 0) return null;

  const valueOf = (s: HookSetting) => (draft[s.key] !== undefined ? draft[s.key] : s.value);
  const commit = (s: HookSetting) => {
    const next = draft[s.key];
    if (next === undefined || next === s.value) return;
    onCommit(hook, s.key, next);
  };

  return (
    <>
      {settings.map((s) => {
        const id = `hook-setting-${hook.id}-${s.key}`;
        return (
          <SettingsRow
            key={s.key}
            indent
            className="hook-setting-row"
            label={s.label}
            help={s.help ? hookHelp(s.help) : undefined}
            htmlFor={id}
            control={s.type === 'boolean' ? (
              <ToggleSwitch id={id} checked={valueOf(s) === true} onChange={(v) => onCommit(hook, s.key, v)} />
            ) : (
              <NumberInput
                id={id}
                value={typeof valueOf(s) === 'number' ? (valueOf(s) as number) : undefined}
                onChange={(v) => setDraft((prev) => ({
                  // Clearing the field must not write `undefined`: fall back to
                  // the declared default so config never holds a null knob.
                  ...prev, [s.key]: v === undefined ? (s.default as number) : v,
                }))}
                onBlur={() => commit(s)}
                onEnter={() => commit(s)}
                unit={s.unit}
                placeholder={String(s.default)}
                min={s.min}
                max={s.max}
              />
            )}
          />
        );
      })}
    </>
  );
}

function HookRow({ hook, name, error, showTag, onToggle, onSettingCommit }: {
  hook: HookInfo;
  /** False when every row of the group has the same tag (N3-11). */
  showTag: boolean;
  /** Sentence-case name, unique in the list (hookNames). */
  name: string;
  error: string | null;
  onToggle: (h: HookInfo, enabled: boolean) => void;
  onSettingCommit: (h: HookInfo, key: string, value: number | boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggleable = hook.mutable !== 'readonly';
  const tag = showTag ? hookTag(hook) : null;
  const detailsId = `hook-details-${hook.id}`;
  const help = HOOK_COPY[hook.id]?.help ?? (hook.description ? hookHelp(hook.description) : null);
  return (
    <>
      <article
        className={`settings-row hook-row${hook.enabled ? '' : ' is-off'}`}
        data-testid={`hook-row-${hook.id}`}
        data-state={error ? 'error' : undefined}
      >
        <div className="settings-row-copy">
          <button
            type="button"
            className="hook-row-disclose"
            aria-expanded={open}
            aria-controls={detailsId}
            data-testid={`hook-disclose-${hook.id}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="settings-row-label hook-row-name" title={hook.name}>{name}</span>
            {tag && <SettingsTag>{tag}</SettingsTag>}
            <ChevronGlyph size={12} className="settings-disclosure-chevron" />
          </button>
          {help && <span className="settings-row-help settings-help-oneline" title={hook.description}><CodeText text={help} /></span>}
        </div>
        <div className="settings-row-actions">
          {toggleable ? (
            <ToggleSwitch
              id={`hook-toggle-${hook.id}`}
              aria-label={name}
              checked={hook.enabled}
              onChange={(v) => onToggle(hook, v)}
            />
          ) : (
            <span title={hook.note ?? 'Not toggleable'}><SettingsTag>Always on</SettingsTag></span>
          )}
        </div>
      </article>
      {error && <p className="settings-row-error" role="alert">{error}</p>}
      <div id={detailsId} className="settings-disclosure-content hook-details" hidden={!open}>
        {/* A hook with plain help keeps its server description out of the
            details: it only repeated the help in developer words (N3-12). */}
        {!HOOK_COPY[hook.id] && hook.description && hookDescription(hook.description) !== help && (
          <SettingsRow indent label="What it does" help={<CodeText text={hookDescription(hook.description)} />} className="hook-description-row" />
        )}
        {hook.on.length > 0 && (
          <SettingsRow indent label="Fires on" control={<span className="settings-mono-value">{hook.on.join(', ')}</span>} />
        )}
        {hook.actionDetail && <SettingsRow indent label="Action" control={<span className="hook-detail-value"><CodeText text={hookDescription(hook.actionDetail)} /></span>} />}
        <SettingsRow indent label="Order" control={<span className="hook-detail-value">{hook.priority}</span>} />
        {hook.conditions.length > 0 && (
          <SettingsRow indent label="Conditions" control={<span className="hook-detail-value"><CodeText text={hookDescription(hook.conditions.join(', '))} /></span>} />
        )}
        {hook.configPath && (
          <SettingsRow indent label="Config" control={<code className="settings-mono-value">{hook.configPath}</code>} />
        )}
        {hook.source === 'daemon-policy' && (
          <SettingsRow indent label="Source" control={<code className="settings-mono-value">daemon-policy</code>} />
        )}
        {hook.note && <SettingsRow indent label="Note" help={<CodeText text={hookDescription(hook.note)} />} />}
        {/* Knobs only while the hook is ON: tuning for something that isn't
            running reads as "configured and active" when it isn't. */}
        {hook.enabled && <HookSettingRows hook={hook} onCommit={onSettingCommit} />}
      </div>
    </>
  );
}

export function HooksSection() {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  // Row errors stay until that hook is edited again or saves (never timed).
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const seq = useRef<Record<string, number>>({});
  const { track } = useSettingsSaved();

  const reload = useCallback(() => {
    fetchHooks()
      .then((list) => { setHooks(list); setError(null); })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load hooks'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const write = useCallback((hook: HookInfo, patch: Parameters<typeof patchHook>[1], apply: (h: HookInfo) => HookInfo) => {
    const mine = (seq.current[hook.id] ?? 0) + 1;
    seq.current[hook.id] = mine;
    // Optimistic; a failure reverts through the reload.
    setHooks((prev) => prev.map((h) => (h.id === hook.id ? apply(h) : h)));
    setRowErrors(({ [hook.id]: _gone, ...rest }) => rest);
    track(patchHook(hook.id, patch), `hooks.${hook.id}`)
      .then((result) => {
        if (seq.current[hook.id] !== mine) return;
        if (result.requiresDaemonRestart) {
          setBanner(`"${HOOK_COPY[hook.id]?.name ?? hookNames([hook]).get(hook.id) ?? hookDisplayName(hook.name)}" updated; it takes effect after the session daemon restarts.`);
        }
        reload();
      })
      .catch((err) => {
        if (seq.current[hook.id] !== mine) return;
        log.warn('settings', 'hook update failed', { hookId: hook.id, error: String(err) });
        setRowErrors((prev) => ({ ...prev, [hook.id]: couldntSave(saveErrorMessage(err)) }));
        reload();
      });
  }, [reload, track]);

  const onToggle = useCallback((hook: HookInfo, enabled: boolean) => {
    write(hook, { enabled }, (h) => ({ ...h, enabled }));
  }, [write]);

  const onSettingCommit = useCallback((hook: HookInfo, key: string, value: number | boolean) => {
    write(hook, { settings: { [key]: value } }, (h) => ({
      ...h, settings: h.settings?.map((s) => (s.key === key ? { ...s, value } : s)),
    }));
  }, [write]);

  const names = useMemo(() => hookNames(hooks), [hooks]);

  // Same shell in all three states, so nothing reflows when the list arrives.
  if (loading || error) {
    return (
      <SettingsSection id="hooks" title="Hooks">
        {loading ? (
          <SettingsGroup><SettingsLoadingRow /></SettingsGroup>
        ) : (
          <SettingsNotice kind="error" role="alert" action={<SettingsButton onClick={reload}>Retry</SettingsButton>}>
            Couldn&apos;t load hooks: {error}
          </SettingsNotice>
        )}
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      id="hooks"
      title="Hooks"
      banner={banner ? (
        <div className="hook-banner" role="status">
          <SettingsNotice
            kind="info"
            action={
              <button type="button" className="hook-banner-dismiss" aria-label="Dismiss" onClick={() => setBanner(null)}>
                <CloseGlyph size={12} />
              </button>
            }
          >
            {banner}
          </SettingsNotice>
        </div>
      ) : undefined}
    >
      {GROUPS.map((group) => {
        const groupHooks = hooks.filter((h) => hookGroupOf(h) === group.key);
        if (groupHooks.length === 0 && group.key !== 'yours') return null;
        // Where your own hooks live: .mjs (Walnut) and .yaml (daemon) files in
        // the hooks folder, or entries in config.yaml (N21).
        const footer = group.key === 'yours' ? (
          <>Add files to <code>~/.open-walnut/hooks/</code> or entries under <code>hooks.defs</code> in <code>config.yaml</code>.</>
        ) : group.footer;
        // No hooks of your own: the same empty row every pane uses (N23).
        if (groupHooks.length === 0) {
          return (
            <SettingsGroup key={group.key} heading={group.title} footer={footer} data-testid={`hooks-group-${group.key}`}>
              <SettingsEmpty>No hooks of your own yet.</SettingsEmpty>
            </SettingsGroup>
          );
        }
        return (
          <SettingsGroup key={group.key} heading={group.title} footer={footer} data-testid={`hooks-group-${group.key}`}>
            {groupHooks.map((hook) => (
              <HookRow
                key={hook.id}
                hook={hook}
                name={HOOK_COPY[hook.id]?.name ?? names.get(hook.id) ?? hookDisplayName(hook.name)}
                error={rowErrors[hook.id] ?? null}
                showTag={groupShowsTags(groupHooks)}
                onToggle={onToggle}
                onSettingCommit={onSettingCommit}
              />
            ))}
          </SettingsGroup>
        );
      })}
    </SettingsSection>
  );
}
