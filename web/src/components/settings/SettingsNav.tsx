import { NavLink } from 'react-router-dom';

interface NavItem {
  id: string;
  label: string;
  divider?: boolean;
}

/**
 * Management pages, at the TOP of the settings sidebar. These ROUTE AWAY (they are
 * their own full pages) rather than scrolling to a section, which is why they are
 * NavLinks and not nav buttons. They used to sit in the app's main sidebar and made
 * it an unreadable icon wall; this is their home now.
 */
const PAGE_LINKS: Array<{ to: string; label: string; testId: string }> = [
  { to: '/agents', label: 'Agents', testId: 'settings-nav-agents' },
  { to: '/skills', label: 'Skills', testId: 'settings-nav-skills' },
  { to: '/commands', label: 'Commands', testId: 'settings-nav-commands' },
  { to: '/memory', label: 'Memory', testId: 'settings-nav-memory' },
  { to: '/tasks', label: 'Tasks table', testId: 'settings-nav-tasks' },
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
  { id: 'memory', label: 'Memory' },
  { id: 'stt', label: 'Speech-to-Text' },
  { id: 'audio-capture', label: 'Audio Capture' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'backup', label: 'S3 Backup' },
  { id: 'remote-hosts', label: 'Remote Hosts' },
  { id: 'devices', label: 'Devices' },
  { id: 'cloud', label: 'Cloud Companion' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'repositories', label: 'Repositories', divider: true },
  { id: 'hooks', label: 'Hooks' },
  { id: 'usage', label: 'Usage & Costs', divider: true },
  { id: 'timeline', label: 'Timeline' },
  { id: 'bug-report', label: 'Bug Report', divider: true },
];

interface SettingsNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

export function SettingsNav({ activeSection, onNavigate }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      <span className="settings-nav-group-label">Manage</span>
      {PAGE_LINKS.map((link) => (
        <NavLink
          key={link.to}
          to={link.to}
          className="settings-nav-item settings-nav-page-link"
          data-testid={link.testId}
        >
          {link.label}
        </NavLink>
      ))}
      <div className="settings-nav-divider" />
      <span className="settings-nav-group-label">Configure</span>
      {NAV_ITEMS.map((item) => (
        <span key={item.id}>
          {item.divider && <div className="settings-nav-divider" />}
          <button
            type="button"
            className={`settings-nav-item${activeSection === item.id ? ' settings-nav-active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            {item.label}
          </button>
        </span>
      ))}
    </nav>
  );
}
