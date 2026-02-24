import { useState, useMemo, useCallback } from 'react';
import { useCommands } from '@/hooks/useCommands';
import { CommandCard } from '@/components/commands/CommandCard';
import { CommandForm } from '@/components/commands/CommandForm';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { CommandDef } from '@/api/commands';

type FilterTab = 'all' | 'builtin' | 'user';

export function CommandsPage() {
  const { commands, loading, error, create, update, remove } = useCommands();
  const [filter, setFilter] = useState<FilterTab>('all');
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
      alert(err instanceof Error ? err.message : 'Failed to delete command');
    }
  }, [remove]);

  if (loading) return <LoadingSpinner />;
  if (error) return <div className="empty-state"><p>Error: {error}</p></div>;

  return (
    <div>
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Commands</h1>
          <p className="page-subtitle">Manage slash commands for quick prompts</p>
        </div>
        {!showForm && (
          <button className="btn btn-primary" onClick={() => { setEditingCommand(undefined); setShowForm(true); }}>
            + New Command
          </button>
        )}
      </div>

      {showForm && (
        <div style={{ marginBottom: 16 }}>
          <CommandForm
            command={editingCommand}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        </div>
      )}

      <div className="cmd-filter-tabs">
        {(['all', 'builtin', 'user'] as const).map((tab) => (
          <button
            key={tab}
            className={`cmd-filter-tab${filter === tab ? ' active' : ''}`}
            onClick={() => setFilter(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({counts[tab]})
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">/</div>
          <p>{filter === 'all' ? 'No commands defined yet' : `No ${filter} commands`}</p>
          {filter === 'all' && (
            <p className="text-sm" style={{ marginTop: 8 }}>Create a command to add quick prompts accessible via /name in chat</p>
          )}
        </div>
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
