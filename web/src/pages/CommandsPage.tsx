import { useState, useMemo, useCallback } from 'react';
import { usePersistentState, oneOf } from '@/hooks/usePersistentState';
import { useCommands } from '@/hooks/useCommands';
import { CommandCard, COMMAND_SOURCE_LABEL } from '@/components/commands/CommandCard';
import { CommandForm } from '@/components/commands/CommandForm';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { NewKey, PageHeader } from '@/components/common/PageHeader';
import { ICON_TERMINAL } from '@/components/common/Icons';
import { Chip, ChipGroup } from '@/components/controls';
import { useAlert } from '@/hooks/useConfirm';
import type { CommandDef } from '@/api/commands';
import '@/styles/header-fit.css';

type FilterTab = 'all' | 'builtin' | 'user';

export function CommandsPage() {
  const { commands, loading, error, refetch, create, update, remove } = useCommands();
  const alert = useAlert();
  const [filter, setFilter] = usePersistentState<FilterTab>(
    'walnut-commands-page-filter', 'all', oneOf(['all', 'builtin', 'user']),
  );
  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<CommandDef | undefined>(undefined);

  const filtered = useMemo(() => {
    if (filter === 'all') return commands;
    return commands.filter((c) => c.source === filter);
  }, [commands, filter]);

  const counts = useMemo(() => ({
    all: commands.length,
    builtin: commands.filter((c) => c.source === 'builtin').length,
    user: commands.filter((c) => c.source === 'user').length,
  }), [commands]);

  const handleSave = useCallback(async (input: { name: string; content: string; description?: string }) => {
    if (editingCommand) {
      await update(editingCommand.name, { content: input.content, description: input.description });
    } else {
      await create(input);
    }
    setShowForm(false);
    setEditingCommand(undefined);
  }, [editingCommand, create, update]);

  const handleEdit = useCallback((cmd: CommandDef) => {
    setEditingCommand(cmd);
    setShowForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setShowForm(false);
    setEditingCommand(undefined);
  }, []);

  const handleDelete = useCallback(async (name: string) => {
    try {
      await remove(name);
    } catch (err) {
      await alert({ title: 'Delete failed', message: err instanceof Error ? err.message : 'Failed to delete command' });
    }
  }, [remove, alert]);

  if (loading) return <LoadingState size="pane" title="Loading commands…" />;
  if (error) return <UnavailableState size="pane" title="Couldn't load commands" detail={error} onRetry={refetch} />;

  return (
    <div className="page-readable">
      <PageHeader
        title="Commands"
        subtitle="Manage slash commands for quick prompts"
        action={!showForm && (
          <NewKey label="New command" onClick={() => { setEditingCommand(undefined); setShowForm(true); }} />
        )}
      />

      {showForm && (
        <div style={{ marginBottom: 16 }}>
          <CommandForm
            command={editingCommand}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
      )}

      <ChipGroup className="cmd-filter-chips" role="group" aria-label="Show">
        {(['all', 'builtin', 'user'] as const).map((tab) => (
          <Chip
            key={tab}
            pressed={filter === tab}
            count={counts[tab]}
            onClick={() => setFilter(tab)}
          >
            {tab === 'all' ? 'All' : COMMAND_SOURCE_LABEL[tab]}
          </Chip>
        ))}
      </ChipGroup>

      {filtered.length === 0 ? (
        filter === 'all'
          ? <EmptyState size="pane" icon={ICON_TERMINAL} title="No commands defined yet" hint="Create a command to add quick prompts you run with /name in chat." />
          : <EmptyState size="pane" icon={ICON_TERMINAL} title={`No ${COMMAND_SOURCE_LABEL[filter].toLowerCase()} commands`} action={{ label: 'Show all commands', onClick: () => setFilter('all') }} />
      ) : (
        <div className="cmd-list">
          {filtered.map((cmd) => (
            <CommandCard
              key={cmd.name}
              command={cmd}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
