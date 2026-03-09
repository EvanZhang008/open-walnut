interface NavItem {
  id: string;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'providers', label: 'AI Providers' },
  { id: 'models', label: 'Models' },
  { id: 'general', label: 'General' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'search', label: 'Search' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'remote-hosts', label: 'Remote Hosts' },
  { id: 'advanced', label: 'Advanced' },
];

interface SettingsNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

export function SettingsNav({ activeSection, onNavigate }: SettingsNavProps) {
  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`settings-nav-item${activeSection === item.id ? ' settings-nav-active' : ''}`}
          onClick={() => onNavigate(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
