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
}

const SOURCE_LABELS: Record<string, string> = {
  skill: 'Skill',
  walnut: 'Walnut',
  'claude-root': 'Claude',
  project: 'Project',
  hardcoded: 'Built-in',
  builtin: 'Built-in',
  user: 'User',
  control: 'Control',
};

export function CommandPalette<T extends PaletteItem = SlashCommand>({ commands, selectedIndex, onSelect, showSource }: CommandPaletteProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  if (commands.length === 0) return null;

  return (
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
            {(showSource || cmd.source === 'control') && cmd.source && (
              <span className={`command-palette-source${cmd.source ? ` command-palette-source-${cmd.source}` : ''}`}>{SOURCE_LABELS[cmd.source] ?? cmd.source}</span>
            )}
          </div>
          {cmd.description && <span className="command-palette-desc">{cmd.description}</span>}
        </div>
      ))}
    </div>
  );
}
