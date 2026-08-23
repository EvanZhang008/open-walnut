import { NavLink } from 'react-router-dom';
import { usePluginUi } from '@/plugins/hooks';
import { CORE_SETTINGS_CONTRIBUTIONS } from './core-settings-registry';

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

const MANAGE_SECTIONS: NavItem[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => entry.group === 'manage')
  .map(({ id, label, divider }) => ({ id, label, divider }));

const NAV_ITEMS: NavItem[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => entry.group === 'configure')
  .map(({ id, label, divider }) => ({ id, label, divider }));

interface SettingsNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

export function SettingsNav({ activeSection, onNavigate }: SettingsNavProps) {
  const pluginUi = usePluginUi();
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
      {pluginUi.settings.length > 0 && (
        <>
          <div className="settings-nav-divider" />
          <span className="settings-nav-group-label">Plugins</span>
          {pluginUi.settings.map((entry) => sectionButton({
            id: entry.key,
            label: entry.value.label,
          }))}
        </>
      )}
    </nav>
  );
}
