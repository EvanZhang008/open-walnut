import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { useSettingsConfig } from '@/hooks/useSettingsConfig';

// Error boundary to prevent a single section crash from taking down the whole page
class SectionErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn(`[Settings] ${this.props.name} crashed:`, error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card settings-section" style={{ borderColor: 'var(--error)' }}>
          <h3 className="settings-section-title">{this.props.name}</h3>
          <p className="text-sm" style={{ color: 'var(--error)' }}>
            This section encountered an error: {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

// Sections
import { GettingStartedSection } from '@/components/settings/sections/GettingStartedSection';
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection';
import { ModelsSection } from '@/components/settings/sections/ModelsSection';
import { GeneralSection } from '@/components/settings/sections/GeneralSection';
import { SessionsSection } from '@/components/settings/sections/SessionsSection';
import { IntegrationsSection } from '@/components/settings/sections/IntegrationsSection';
import { SearchSection } from '@/components/settings/sections/SearchSection';
import { HeartbeatSection } from '@/components/settings/sections/HeartbeatSection';
import { RemoteHostsSection } from '@/components/settings/sections/RemoteHostsSection';
import { AdvancedSection } from '@/components/settings/sections/AdvancedSection';

const SECTION_IDS = [
  'getting-started', 'providers', 'models', 'general', 'sessions',
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
      const containerRect = container.getBoundingClientRect();
      // Find the last section whose top is above the midpoint of the container
      const threshold = containerRect.top + 80;
      for (let i = SECTION_IDS.length - 1; i >= 0; i--) {
        const el = document.getElementById(SECTION_IDS[i]);
        if (el && el.getBoundingClientRect().top <= threshold) {
          setActiveSection(SECTION_IDS[i]);
          return;
        }
      }
      setActiveSection(SECTION_IDS[0]);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

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
  }, [handleNavigate]);

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
          <SectionErrorBoundary name="Getting Started"><GettingStartedSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="AI Providers"><ProvidersSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Models"><ModelsSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="General"><GeneralSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Sessions"><SessionsSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Integrations"><IntegrationsSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Search"><SearchSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Heartbeat"><HeartbeatSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Remote Hosts"><RemoteHostsSection config={config} onSave={saveSection} /></SectionErrorBoundary>
          <SectionErrorBoundary name="Advanced"><AdvancedSection config={config} onSave={saveSection} /></SectionErrorBoundary>
        </div>
      </div>
    </div>
  );
}
