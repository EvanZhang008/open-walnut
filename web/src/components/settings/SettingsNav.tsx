interface NavItem {
  id: string;
  label: string;
  divider?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'providers', label: 'AI Provider' },
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Tasks & Sessions' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'plugin-store', label: 'Plugin Store' },
  { id: 'search', label: 'Search & Embeddings' },
  { id: 'memory', label: 'Memory' },
  { id: 'stt', label: 'Speech-to-Text' },
  { id: 'audio-capture', label: 'Audio Capture' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'remote-hosts', label: 'Remote Hosts' },
  { id: 'devices', label: 'Devices' },
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
