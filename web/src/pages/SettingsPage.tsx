import { useState, useEffect, useCallback, useRef, useMemo, Component, type ReactNode, type ErrorInfo } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { useSettingsConfig } from '@/hooks/useSettingsConfig';
import { PluginBoundary } from '@/components/common/PluginBoundary';
import { CORE_SETTINGS_CONTRIBUTIONS } from '@/components/settings/core-settings-registry';
import { usePluginUi } from '@/plugins/hooks';

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

const CORE_SECTION_IDS = CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.id);

export function SettingsPage() {
  const { config, loading, error, saveSection, reload } = useSettingsConfig();
  const pluginUi = usePluginUi();
  const sectionIds = useMemo(
    () => [...CORE_SECTION_IDS, ...pluginUi.settings.map((entry) => entry.key)],
    [pluginUi.settings],
  );
  const [activeSection, setActiveSection] = useState(CORE_SECTION_IDS[0]);
  const contentRef = useRef<HTMLDivElement>(null);

  // Track active section via scroll position
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const handleScroll = () => {
      const containerRect = container.getBoundingClientRect();
      // Find the last section whose top is above the midpoint of the container
      const threshold = containerRect.top + 80;
      for (let i = sectionIds.length - 1; i >= 0; i--) {
        const el = document.getElementById(sectionIds[i]);
        if (el && el.getBoundingClientRect().top <= threshold) {
          setActiveSection(sectionIds[i]);
          return;
        }
      }
      setActiveSection(sectionIds[0]);
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [sectionIds]);

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
    if (hash && sectionIds.includes(hash)) {
      setTimeout(() => handleNavigate(hash), 100);
    }
  }, [handleNavigate, sectionIds]);

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
          {CORE_SETTINGS_CONTRIBUTIONS.map((entry) => (
            <SectionErrorBoundary key={`${entry.owner}:${entry.id}`} name={entry.title}>
              {entry.render({ config, saveSection, reload })}
            </SectionErrorBoundary>
          ))}
          {pluginUi.settings.map((entry) => {
            const PluginSettings = entry.value.component;
            return (
              <section
                id={entry.key}
                key={`${entry.key}:${entry.generation}`}
                className="card settings-section plugin-settings-section"
                data-plugin-id={entry.pluginId}
              >
                <h3 className="settings-section-title">{entry.value.label}</h3>
                <PluginBoundary
                  pluginId={entry.pluginId}
                  pluginName={entry.pluginName}
                  resetKey={entry.generation}
                >
                  <PluginSettings />
                </PluginBoundary>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
