import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LifecycleSection } from './lifecycle-section'
import { PlatformSection } from './platform-section'
import { RegistrySection } from './registry-section'
import { ServerSection } from './server-section'
import { ViewsSection } from './views-section'
import { WebSection } from './web-section'
import { SECTION_IDS, SECTION_LABELS, type DemoContext, type LayoutMode, type SectionId } from './types'

const COMPACT_WIDTH = 560

export interface DemoAppProps {
  demo: DemoContext
  basePath: string
  subpath: string
  search: string
  navigate(path: string, options?: { replace?: boolean }): void
}

export function DemoApp(props: DemoAppProps) {
  const { demo, basePath, subpath, search, navigate } = props
  const [section, setSection] = useState<SectionId>(() => sectionFromSubpath(subpath))
  const [layout, setLayout] = useState<LayoutMode>('wide')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setSection(sectionFromSubpath(subpath))
  }, [subpath])

  // Measure the host-owned canvas rather than assuming it matches the viewport.
  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) return
    const apply = (width: number) => setLayout(width < COMPACT_WIDTH ? 'compact' : 'wide')
    apply(element.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) apply(entry.contentRect.width)
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const openSection = (id: SectionId) => {
    setSection(id)
    navigate(joinPath(basePath, id))
  }

  return (
    <div
      className={`wd-root wd-${layout}`}
      data-testid="plugin-demo-app"
      data-section={section}
      data-layout={layout}
      ref={rootRef}
    >
      <header className="wd-header">
        <div>
          <span className="wd-kicker">Native plugin app</span>
          <h1>{demo.walnut.pluginName}</h1>
          <p>
            Every public plugin capability, driven from one app. Each trigger reports a receipt, and the
            demo only ever touches what it owns.
          </p>
        </div>
      </header>

      <nav className="wd-tabs" role="tablist" aria-label="Plugin Demo sections">
        {SECTION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === section}
            className={`wd-tab ${id === section ? 'wd-tab-active' : ''}`}
            data-testid={`plugin-demo-tab-${id}`}
            onClick={() => openSection(id)}
          >
            {SECTION_LABELS[id]}
          </button>
        ))}
      </nav>

      <main className="wd-section" data-testid={`plugin-demo-section-${section}`}>
        {section === 'platform' && (
          <PlatformSection
            demo={demo}
            section={section}
            layout={layout}
            deepLink={deepLinkFor(basePath, section)}
            search={search}
          />
        )}
        {section === 'views' && <ViewsSection demo={demo} />}
        {section === 'web' && <WebSection demo={demo} />}
        {section === 'server' && <ServerSection demo={demo} />}
        {section === 'registry' && <RegistrySection demo={demo} />}
        {section === 'lifecycle' && <LifecycleSection demo={demo} />}
      </main>
    </div>
  )
}

export function sectionFromSubpath(subpath: string): SectionId {
  const first = subpath.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? ''
  return SECTION_IDS.find((id) => id === first) ?? 'platform'
}

function joinPath(basePath: string, section: SectionId): string {
  return `${basePath.replace(/\/+$/, '')}/${section}`
}

export function deepLinkFor(basePath: string, section: SectionId): string {
  const path = joinPath(basePath, section)
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`
}
