/**
 * Import notes' web entry: one App (in the sidebar) and its CSS.
 */
import type { AppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { ImportApp } from './web/app'
import { createImportStore } from './web/store'
import { IMPORT_CSS } from './web/styles'

/** The documented default weight for a plugin App (core screens use 10 to 1000). */
const APP_ORDER = 500

export async function activate(walnut: WalnutWebApi) {
  const store = createImportStore(walnut)

  function ImportIcon({ size = 18 }: { size?: number }) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 3.8h8.2L18.5 8v12.2H6z" />
        <path d="M14 3.8V8h4.5" />
        <path d="M12.2 10.6v6.2M9.4 14.2l2.8 2.8 2.8-2.8" />
      </svg>
    )
  }

  function ImportAppRoot(props: AppProps) {
    return <ImportApp {...props} walnut={walnut} store={store} />
  }

  walnut.ui.app({
    id: 'main',
    title: 'Import notes',
    icon: ImportIcon,
    component: ImportAppRoot,
    badge: null,
    order: APP_ORDER,
    fullBleed: true,
  })
  walnut.ui.injectCss(IMPORT_CSS)
}
