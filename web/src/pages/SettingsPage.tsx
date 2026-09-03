import { useState, useEffect, useCallback, useMemo, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { SettingsNav } from '@/components/settings/SettingsNav';
import { SettingsSection } from '@/components/settings/SettingsSection';
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
        <div className="settings-section settings-card" style={{ borderColor: 'var(--error)' }}>
          <header className="settings-card-head">
            <div className="settings-card-heading">
              <h3 className="settings-section-title">{this.props.name}</h3>
            </div>
          </header>
          <p className="settings-notice settings-notice-error">
            This section encountered an error: {this.state.error.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const CORE_SECTION_IDS = CORE_SETTINGS_CONTRIBUTIONS.map((entry) => entry.id);

/** Any of these means the person took the wheel — hash anchoring must let go. */
const USER_TAKEOVER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;

export function SettingsPage() {
  const { config, loading, error, saveSection, reload } = useSettingsConfig();
  const pluginUi = usePluginUi();
  const sectionIds = useMemo(
    () => [...CORE_SECTION_IDS, ...pluginUi.settings.map((entry) => entry.key)],
    [pluginUi.settings],
  );
  const [activeSection, setActiveSection] = useState(CORE_SECTION_IDS[0]);
  // A callback ref, not useRef: the page renders a spinner until the config
  // arrives, so a plain ref is still null when the effect below first runs and
  // the effect never re-ran — the nav highlight stayed on the first entry no
  // matter how far the person scrolled. State re-runs the effect on mount.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  // While a nav click (or the URL hash) is steering the page, the scroll spy
  // stays quiet: the highlight is the section the person asked for, not every
  // card the smooth scroll passes on the way there.
  const steeringRef = useRef<(() => void) | null>(null);

  // Track active section via scroll position
  useEffect(() => {
    if (!container) return;
    const handleScroll = () => {
      if (steeringRef.current) return;
      // At the very bottom the last sections can never reach the threshold
      // line (there is nothing left to scroll), so the bottom means "last".
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) {
        for (let i = sectionIds.length - 1; i >= 0; i--) {
          if (document.getElementById(sectionIds[i])) { setActiveSection(sectionIds[i]); return; }
        }
      }
      const containerRect = container.getBoundingClientRect();
      // Find the last section whose top is above the threshold line
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
  }, [container, sectionIds]);

  // The nav is taller than short windows; keep the highlighted entry in view.
  useEffect(() => {
    const item = document.querySelector<HTMLElement>(`[data-testid="settings-nav-${activeSection}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeSection]);

  // Scroll to a section and KEEP it there until layout settles.
  // Two races killed the old one-shot scrollIntoView: the config fetch gates
  // the page behind a spinner (element not there yet), and after the first
  // scroll the async sections above the target keep growing and push it back
  // out of view (a nav click on the last cards landed mid-Usage & Costs while
  // that card was still loading its tables). So: retry until the element
  // exists, re-anchor each tick while its position still moves, stop once it's
  // been stable for a few ticks — and hand over immediately if the user scrolls
  // or types. `smooth` animates the first hop only; the re-anchors are instant.
  const steerTo = useCallback((id: string, smooth: boolean) => {
    steeringRef.current?.();
    let tries = 0;
    let lastTop: number | null = null;
    let stableTicks = 0;
    let hopped = false;
    const stop = () => {
      clearInterval(timer);
      for (const event of USER_TAKEOVER_EVENTS) window.removeEventListener(event, stop);
      if (steeringRef.current === stop) steeringRef.current = null;
    };
    const tick = () => {
      tries += 1;
      const el = document.getElementById(id);
      if (el) {
        const top = el.getBoundingClientRect().top;
        stableTicks = lastTop !== null && Math.abs(top - lastTop) < 1 ? stableTicks + 1 : 0;
        lastTop = top;
        // Stable AND where it should be: done. Stable but off (the smooth hop
        // finished on a stale destination) falls through to an instant re-anchor.
        const anchored = Math.abs(top - (container?.getBoundingClientRect().top ?? 0)) < 2
          || (container ? container.scrollTop + container.clientHeight >= container.scrollHeight - 2 : false);
        if (stableTicks >= 3 && anchored) { stop(); return; }
        if (!hopped || stableTicks >= 2) {
          el.scrollIntoView({ behavior: !hopped && smooth ? 'smooth' : 'auto', block: 'start' });
          hopped = true;
        }
        setActiveSection(id);
        window.history.replaceState(null, '', `#${id}`);
      }
      if (tries >= 100) stop();
    };
    const timer = setInterval(tick, 100);
    for (const event of USER_TAKEOVER_EVENTS) {
      window.addEventListener(event, stop, { passive: true });
    }
    steeringRef.current = stop;
    tick();
    return stop;
  }, [container]);

  // Navigate to section
  const handleNavigate = useCallback((id: string) => {
    if (document.getElementById(id)) steerTo(id, true);
  }, [steerTo]);

  // On mount, scroll to the URL hash.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash || !sectionIds.includes(hash) || !container) return;
    return steerTo(hash, false);
  }, [sectionIds, container, steerTo]);

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
      <div className="settings-content" ref={setContainer}>
        <div className="settings-content-inner">
          {/* Same width as every card below it, so the page reads as one column. */}
          <div className="page-header settings-page-header">
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Configure everything from one place</p>
          </div>
          {CORE_SETTINGS_CONTRIBUTIONS.map((entry) => (
            <SectionErrorBoundary key={`${entry.owner}:${entry.id}`} name={entry.title}>
              {entry.render({ config, saveSection, reload })}
            </SectionErrorBoundary>
          ))}
          {/* A plugin's own settings panel gets the SAME shell as a core section —
              its interior is the plugin's, its frame is Walnut's. */}
          {pluginUi.settings.map((entry) => {
            const PluginSettings = entry.value.component;
            return (
              <SettingsSection
                key={`${entry.key}:${entry.generation}`}
                id={entry.key}
                title={entry.value.label}
                description={`Provided by the ${entry.pluginName} plugin.`}
                className="plugin-settings-section"
                data-plugin-id={entry.pluginId}
              >
                <PluginBoundary
                  pluginId={entry.pluginId}
                  pluginName={entry.pluginName}
                  resetKey={entry.generation}
                >
                  <PluginSettings />
                </PluginBoundary>
              </SettingsSection>
            );
          })}
        </div>
      </div>
    </div>
  );
}
