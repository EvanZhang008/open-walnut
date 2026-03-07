import { useState, useEffect, useCallback, useRef } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { useSettingsConfig } from '@/hooks/useSettingsConfig';

// Sections
import { GettingStartedSection } from '@/components/settings/sections/GettingStartedSection';
import { ModelsSection } from '@/components/settings/sections/ModelsSection';
import { GeneralSection } from '@/components/settings/sections/GeneralSection';
import { SessionsSection } from '@/components/settings/sections/SessionsSection';
import { IntegrationsSection } from '@/components/settings/sections/IntegrationsSection';
import { SearchSection } from '@/components/settings/sections/SearchSection';
import { HeartbeatSection } from '@/components/settings/sections/HeartbeatSection';
import { RemoteHostsSection } from '@/components/settings/sections/RemoteHostsSection';
import { AdvancedSection } from '@/components/settings/sections/AdvancedSection';

const SECTION_IDS = [
  'getting-started', 'models', 'general', 'sessions',
  'integrations', 'search', 'heartbeat', 'remote-hosts', 'advanced',
];

export function SettingsPage() {
  const { config, loading, error, saveSection } = useSettingsConfig();
  const [activeSection, setActiveSection] = useState('getting-started');
  const contentRef = useRef<HTMLDivElement>(null);

  // Track active section via scroll position
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const handleScroll = () => {
      const scrollTop = container.scrollTop + 40;
      for (let i = SECTION_IDS.length - 1; i >= 0; i--) {
        const el = document.getElementById(SECTION_IDS[i]);
        if (el && el.offsetTop <= scrollTop) {
          setActiveSection(SECTION_IDS[i]);
          return;
        }
      }
      setActiveSection(SECTION_IDS[0]);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [config]);

  // Navigate to section
  const handleNavigate = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(id);
      window.history.replaceState(null, '', `#${id}`);
    }
  }, []);

  // On mount, scroll to hash
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash && SECTION_IDS.includes(hash)) {
      setTimeout(() => handleNavigate(hash), 100);
    }
  }, [handleNavigate, config]);

  // Cmd+S to save the focused section
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const form = document.getElementById(activeSection) as HTMLFormElement | null;
        if (form?.requestSubmit) form.requestSubmit();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeSection]);

  if (loading) return <LoadingSpinner />;
  if (!config && error) {
    return <div className="empty-state"><p>Error: {error}</p></div>;
  }
  if (!config) return null;

  return (
    <div className="settings-layout">
      <SettingsNav activeSection={activeSection} onNavigate={handleNavigate} />
      <div className="settings-content" ref={contentRef}>
        <div className="settings-content-inner">
          <div className="page-header">
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Configure everything from one place</p>
          </div>
          <GettingStartedSection config={config} onSave={saveSection} />
          <ModelsSection config={config} onSave={saveSection} />
          <GeneralSection config={config} onSave={saveSection} />
          <SessionsSection config={config} onSave={saveSection} />
          <IntegrationsSection config={config} onSave={saveSection} />
          <SearchSection config={config} onSave={saveSection} />
          <HeartbeatSection config={config} onSave={saveSection} />
          <RemoteHostsSection config={config} onSave={saveSection} />
          <AdvancedSection config={config} onSave={saveSection} />
        </div>
      </div>
    </div>
  );
}
