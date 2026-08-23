import { useEffect, useRef } from 'react';
import type { SlashCommand } from '../../commands/types';

/** Minimal shape required for palette rendering. Both SlashCommand and SlashCommandItem satisfy this. */
export interface PaletteItem {
  name: string;
  description: string;
  source?: string;
}

interface CommandPaletteProps<T extends PaletteItem = SlashCommand> {
  commands: T[];
  selectedIndex: number;
  onSelect: (cmd: T) => void;
  showSource?: boolean;
  /** Session mode: re-scan the (possibly remote) skill/command list. Renders a refresh footer. */
  onRefresh?: () => void;
  /** True while a refresh is in flight — disables the button + shows a spinning state. */
  refreshing?: boolean;
}

// Covers multiple type vocabularies: SlashCommandItem (API) + SlashCommand (local registry).
const SOURCE_LABELS: Record<string, string> = {
  skill: 'Skill',
  walnut: 'Walnut',
  'claude-root': 'Claude',
  project: 'Project',
  'built-in': 'Built-in',  // API: Claude Code native commands
  hardcoded: 'Built-in',   // Local registry: hardcoded commands
  builtin: 'Built-in',     // Local registry: built-in commands
  user: 'User',
  plugin: 'Plugin',        // Registered by an active plugin (`<pluginId>:<id>`)
  control: 'Control',
};

export function CommandPalette<T extends PaletteItem = SlashCommand>({ commands, selectedIndex, onSelect, showSource, onRefresh, refreshing }: CommandPaletteProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
    <div className="command-palette-wrap">
      <div className="command-palette" ref={listRef}>
        {commands.map((cmd, i) => (
          <div
            key={cmd.name}
            className={`command-palette-item${i === selectedIndex ? ' command-palette-item-active' : ''}${cmd.source === 'control' ? ' command-palette-control' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(cmd);
            }}
          >
            <div className="command-palette-row">
              <span className="command-palette-name">/{cmd.name}</span>
              {(showSource || cmd.source === 'control' || cmd.source === 'skill' || cmd.source === 'plugin') && cmd.source && (
                <span className={`command-palette-source${cmd.source ? ` command-palette-source-${cmd.source}` : ''}`}>{SOURCE_LABELS[cmd.source] ?? cmd.source}</span>
              )}
            </div>
            {cmd.description && <span className="command-palette-desc">{cmd.description}</span>}
          </div>
        ))}
      </div>
      {onRefresh && (
        <button
          type="button"
          className="command-palette-refresh"
          // onMouseDown (not onClick) so it fires before the input's blur closes the palette.
          onMouseDown={(e) => { e.preventDefault(); if (!refreshing) onRefresh(); }}
          disabled={refreshing}
          title="Re-scan skills & commands (e.g. after creating one on the remote host)"
        >
          <span className={`command-palette-refresh-icon${refreshing ? ' spinning' : ''}`}>{'↻'}</span>
          {refreshing ? 'Refreshing…' : 'Refresh list'}
        </button>
      )}
    </div>
  );
}
