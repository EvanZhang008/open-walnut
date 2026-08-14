import { useNavigate } from 'react-router-dom';
import { SectionCard } from '../inputs/SectionCard';

/** Management surfaces that used to crowd the sidebar. They are configuration,
 *  not day-to-day panels, so they live behind Settings now. */
const LINKS: Array<{ to: string; label: string; hint: string; testId: string }> = [
  { to: '/agents', label: 'Agents', hint: 'Sub-agent definitions the AI can delegate to', testId: 'manage-link-agents' },
  { to: '/skills', label: 'Skills', hint: 'Skill extensions the AI loads on demand', testId: 'manage-link-skills' },
  { to: '/commands', label: 'Commands', hint: 'Slash commands available in sessions', testId: 'manage-link-commands' },
  { to: '/memory', label: 'Memory', hint: 'Long-term memories and learned context', testId: 'manage-link-memory' },
  { to: '/tasks', label: 'Tasks table', hint: 'Full task table view (the Home Todo panel is the primary surface)', testId: 'manage-link-tasks' },
];

export function ManageSection() {
  const navigate = useNavigate();

  return (
    <SectionCard
      id="manage"
      title="Manage"
      description="Browse and edit what the AI can use. These pages open full-screen."
    >
      <div className="settings-manage-grid">
        {LINKS.map((link) => (
          <button
            key={link.to}
            type="button"
            className="settings-manage-card"
            data-testid={link.testId}
            onClick={() => navigate(link.to)}
          >
            <span className="settings-manage-label">{link.label}</span>
            <span className="settings-manage-hint">{link.hint}</span>
          </button>
        ))}
      </div>
    </SectionCard>
  );
}
