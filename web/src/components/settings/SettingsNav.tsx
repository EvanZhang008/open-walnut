import { NavLink } from 'react-router-dom';
import { useAppCatalog } from '@/apps/hooks';
import { usePluginUi } from '@/plugins/hooks';
import { CORE_SETTINGS_CONTRIBUTIONS } from './core-settings-registry';

interface NavItem {
  id: string;
  label: string;
  divider?: boolean;
}

/**
 * The settings sidebar has THREE groups, split by what the entry IS rather than by
 * how it navigates:
 *
 * - Manage: browse-and-edit lists of things the AI uses (agents, skills, commands,
 *   memories, repos, hooks). Some are their own full pages (NavLink, marked with a
 *   chevron) and some are sections on this page (scroll button) — the group is about
 *   the content, not the mechanism.
 * - Plugins: everything plugin-shaped in ONE place — the Plugins section (install,
 *   on/off, configure), every plugin App that declared `placement: 'settings'` (a
 *   page link from the SAME App Registry the app sidebar reads, so it appears and
 *   disappears with the plugin's own lifecycle and needs no separate registration
 *   channel; its badge rides the row), and any settings panel a plugin registered.
 * - Configure: the knobs. Every entry scrolls to a section here.
 * - Diagnostics: read-mostly panels about what Walnut did (usage, screen tracking,
 *   bug report). Not knobs, so not mixed in with them.
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

const PLUGIN_SECTIONS: NavItem[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => entry.group === 'plugins')
  .map(({ id, label, divider }) => ({ id, label, divider }));

const NAV_ITEMS: NavItem[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => entry.group === 'configure' && !entry.navHidden)
  .map(({ id, label, divider }) => ({ id, label, divider }));

const DIAGNOSTICS_ITEMS: NavItem[] = CORE_SETTINGS_CONTRIBUTIONS
  .filter((entry) => entry.group === 'diagnostics' && !entry.navHidden)
  .map(({ id, label, divider }) => ({ id, label, divider }));

/**
 * A `navHidden` section (Focus Tiers under Tasks, Cloud Companion under Phones &
 * Cloud) has no button of its own, so when the scroll spy lands on it the entry it
 * folds under lights up instead of nothing.
 */
const NAV_OWNER: Record<string, string> = (() => {
  const owner: Record<string, string> = {};
  let lastVisible = '';
  for (const entry of CORE_SETTINGS_CONTRIBUTIONS) {
    if (!entry.navHidden) lastVisible = entry.id;
    owner[entry.id] = lastVisible;
  }
  return owner;
})();

interface SettingsNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

export function SettingsNav({ activeSection, onNavigate }: SettingsNavProps) {
  const pluginUi = usePluginUi();
  const apps = useAppCatalog();
  const highlighted = NAV_OWNER[activeSection] ?? activeSection;
  const sectionButton = (item: NavItem) => (
    <span key={item.id}>
      {item.divider && <div className="settings-nav-divider" />}
      <button
        type="button"
        className={`settings-nav-item${highlighted === item.id ? ' settings-nav-active' : ''}`}
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
      <span className="settings-nav-group-label">Plugins</span>
      {PLUGIN_SECTIONS.map(sectionButton)}
      {apps.settings.map((app) => (
        <NavLink
          key={`${app.key}:${app.generation}`}
          to={app.path}
          className="settings-nav-item settings-nav-page-link"
          data-testid={`settings-nav-app-${app.key}`}
          data-app-kind={app.kind}
        >
          {app.title}
          {app.badge === 'dot' ? (
            <span className="notification-badge-dot" />
          ) : typeof app.badge === 'number' && app.badge > 0 ? (
            <span className="notification-badge-count">{app.badge > 99 ? '99+' : app.badge}</span>
          ) : null}
        </NavLink>
      ))}
      {pluginUi.settings.map((entry) => sectionButton({
        id: entry.key,
        label: entry.value.label,
      }))}
      <div className="settings-nav-divider" />
      <span className="settings-nav-group-label">Configure</span>
      {NAV_ITEMS.map(sectionButton)}
      <div className="settings-nav-divider" />
      <span className="settings-nav-group-label">Diagnostics</span>
      {DIAGNOSTICS_ITEMS.map(sectionButton)}
    </nav>
  );
}
