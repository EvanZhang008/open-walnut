import { NavLink } from 'react-router-dom';

interface NavItem {
  id: string;
  label: string;
  divider?: boolean;
}

/**
 * The settings sidebar has TWO groups, split by what the entry IS rather than by
 * how it navigates:
 *
 * - Manage: browse-and-edit lists of things the AI uses (agents, skills, commands,
 *   memories, repos, hooks). Some are their own full pages (NavLink, marked with a
 *   chevron) and some are sections on this page (scroll button) — the group is about
 *   the content, not the mechanism.
 * - Configure: the knobs. Every entry scrolls to a section here.
 *
 * Agents/Skills/Commands/Memory used to live in the app's main sidebar and turned it
 * into an unreadable icon wall; this is their home now. The Tasks table is NOT here:
 * it is a daily surface, so it stayed in the app sidebar.
 *
 * There is no "Memory" entry under Configure: the old MemorySection's entire body was
 * a button to /memory, which the Manage link above now is.
 */
const MANAGE_PAGES: Array<{ to: string; label: string; testId: string }> = [
  { to: '/agents', label: 'Agents', testId: 'settings-nav-agents' },
  { to: '/skills', label: 'Skills', testId: 'settings-nav-skills' },
  { to: '/commands', label: 'Commands', testId: 'settings-nav-commands' },
  { to: '/memory', label: 'Memory', testId: 'settings-nav-memory' },
];

/** Manage entries that are sections on this page, not separate routes. */
const MANAGE_SECTIONS: NavItem[] = [
  { id: 'repositories', label: 'Repositories' },
  { id: 'hooks', label: 'Hooks' },
];

const NAV_ITEMS: NavItem[] = [
  { id: 'providers', label: 'AI Provider' },
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Tasks & Sessions' },
  { id: 'focus-tiers', label: 'Focus Tiers' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'plugin-store', label: 'Plugin Store' },
  { id: 'search', label: 'Search & Embeddings' },
  { id: 'stt', label: 'Speech-to-Text' },
  { id: 'audio-capture', label: 'Audio Capture' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'backup', label: 'S3 Backup' },
  { id: 'remote-hosts', label: 'Remote Hosts' },
  { id: 'devices', label: 'Devices' },
  { id: 'cloud', label: 'Cloud Companion' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'usage', label: 'Usage & Costs', divider: true },
  { id: 'timeline', label: 'Timeline' },
  { id: 'bug-report', label: 'Bug Report', divider: true },
];

interface SettingsNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

export function SettingsNav({ activeSection, onNavigate }: SettingsNavProps) {
  const sectionButton = (item: NavItem) => (
    <span key={item.id}>
      {item.divider && <div className="settings-nav-divider" />}
      <button
        type="button"
        className={`settings-nav-item${activeSection === item.id ? ' settings-nav-active' : ''}`}
        data-testid={`settings-nav-${item.id}`}
        onClick={() => onNavigate(item.id)}
      >
        {item.label}
      </button>
    </span>
  );

  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <span className="settings-nav-group-label">Manage</span>
      {MANAGE_PAGES.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className="settings-nav-item settings-nav-page-link"
          data-testid={link.testId}
        >
          {link.label}
        </NavLink>
      ))}
      {MANAGE_SECTIONS.map(sectionButton)}
      <div className="settings-nav-divider" />
      <span className="settings-nav-group-label">Configure</span>
      {NAV_ITEMS.map(sectionButton)}
    </nav>
  );
}
