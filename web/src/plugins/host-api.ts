import { apiGet, apiPost } from '@/api/client'
import { getDeviceToken } from '@/api/device-token'
import { wsClient } from '@/api/ws'
import { getAppInfo } from '@/utils/app-info'
import { log } from '@/utils/log'
import { disposable, type WebPluginContext } from './disposable'
import { pluginUiRegistry } from './registry'
import { createPluginViews } from './views'
import type {
  PluginEvent,
  PluginFetchInit,
  PluginFetchResponse,
  PluginLogger,
  PluginNavContribution,
  PluginPageContribution,
  PluginPanelContribution,
  PluginSettingsContribution,
  WalnutWebApiHost,
} from './types'

const LOCAL_EVENT = 'walnut:plugin-web-event'
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const RESERVED_PAGE_ROOTS = new Set([
  '/',
  '/agents',
  '/apps',
  '/calendar',
  '/chat',
  '/commands',
  '/cron',
  '/dashboard',
  '/hooks',
  '/memory',
  '/notes',
  '/popout',
  '/repos',
  '/routines',
  '/search',
  '/sessions',
  '/settings',
  '/skills',
  '/tasks',
  '/timeline',
  '/usage',
])

function loggerFor(pluginId: string, child?: string): PluginLogger {
  const subsystem = `plugin/${pluginId}${child ? `/${child}` : ''}`
  return {
    trace: (message, data) => log.debug(subsystem, message, data),
    debug: (message, data) => log.debug(subsystem, message, data),
    info: (message, data) => log.info(subsystem, message, data),
    warn: (message, data) => log.warn(subsystem, message, data),
    error: (message, data) => log.error(subsystem, message, data),
    fatal: (message, data) => log.error(subsystem, message, data),
    child: (name) => loggerFor(pluginId, child ? `${child}/${name}` : name),
  }
}

function validateLocalId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new Error(`Plugin contribution id is invalid: ${JSON.stringify(id)}`)
}

function validatePath(value: string): void {
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\0')
    || value.replace(/\\/g, '/').split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Plugin route path is invalid: ${JSON.stringify(value)}`)
  }
}

function validatePagePath(value: string): void {
  validatePath(value)
  if (value.includes('?') || value.includes('#')) {
    throw new Error(`Plugin page path is invalid: ${JSON.stringify(value)}`)
  }
  for (const reserved of RESERVED_PAGE_ROOTS) {
    if (value === reserved || (reserved !== '/' && value.startsWith(`${reserved}/`))) {
      throw new Error(`Plugin page path conflicts with Walnut: ${JSON.stringify(value)}`)
    }
  }
}

function validateComponent(component: unknown): void {
  if (typeof component !== 'function' && typeof component !== 'object') {
    throw new Error('Plugin UI contribution requires a React component')
  }
}

function publicFetchResponse(response: Response): PluginFetchResponse {
  return {
    ok: response.ok,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text: () => response.text(),
    json: <T>() => response.json() as Promise<T>,
  }
}

function normalizeEventName(pluginId: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(name)) {
    throw new Error(`Invalid Plugin event name: ${JSON.stringify(name)}`)
  }
  return `plugin:${pluginId}:${name}`
}

export function createWebPluginApi(
  pluginId: string,
  pluginName: string,
  context: WebPluginContext,
): WalnutWebApiHost {
  const pluginLog = loggerFor(pluginId)
  let unsafeWarned = false
  const own = context.own.bind(context)

  return {
    pluginId,
    pluginName,
    walnutVersion: getAppInfo()?.version ?? 'unknown',
    signal: context.signal,
    log: pluginLog,
    events: {
      on(prefixInput, handler) {
        const prefixes = Array.isArray(prefixInput) ? prefixInput : [prefixInput]
        if (prefixes.length === 0 || prefixes.some((prefix) => !prefix)) {
          throw new Error('Plugin event subscription requires at least one prefix')
        }
        const deliver = (name: string, data: unknown) => {
          if (!prefixes.some((prefix) => name.startsWith(prefix))) return
          void Promise.resolve(handler({
            name,
            data,
            timestamp: Date.now(),
          })).catch((error) => pluginLog.error('event handler failed', {
            name,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
        const unsubscribeWs = wsClient.subscribeAll(deliver)
        const onLocal = (event: Event) => {
          const pluginEvent = (event as CustomEvent<PluginEvent>).detail
          if (pluginEvent) deliver(pluginEvent.name, pluginEvent.data)
        }
        window.addEventListener(LOCAL_EVENT, onLocal)
        return own(disposable(() => {
          unsubscribeWs()
          window.removeEventListener(LOCAL_EVENT, onLocal)
        }))
      },
      emit(name, data) {
        const event: PluginEvent = {
          name: normalizeEventName(pluginId, name),
          data,
          timestamp: Date.now(),
          source: `plugin/${pluginId}`,
        }
        window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: event }))
      },
    },
    ops: {
      call<T = unknown>(name: string, args: Record<string, unknown> = {}) {
        return apiPost(`/api/plugin-runtime/${encodeURIComponent(pluginId)}/ops/${encodeURIComponent(name)}`, args) as Promise<
          { ok: true; result: T } | { ok: false; message: string }
        >
      },
      unwrap<T>(result: { ok: true; result: T } | { ok: false; message: string }): T {
        if (!result.ok) throw new Error(result.message)
        return result.result
      },
      async list() {
        const response = await apiGet<{ ops: Array<{ name: string; title: string; readonly: boolean }> }>(
          `/api/plugin-runtime/${encodeURIComponent(pluginId)}/ops`,
        )
        return response.ops
      },
    },
    ws: {
      call<T = unknown>(id: string, payload: unknown = {}) {
        validateLocalId(id)
        return wsClient.sendRpc<T>(`${pluginId}:${id}`, payload)
      },
    },
    http: {
      async fetch(url: string, init: PluginFetchInit = {}) {
        const target = new URL(url, window.location.href)
        const headers = new Headers(init.headers)
        if (target.origin === window.location.origin) {
          const token = getDeviceToken()
          if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
        }
        const response = await fetch(target, {
          method: init.method,
          headers,
          body: init.body as BodyInit | undefined,
          signal: AbortSignal.any([
            context.signal,
            AbortSignal.timeout(init.timeoutMs ?? 30_000),
          ]),
        })
        return publicFetchResponse(response)
      },
    },
    ui: {
      nav(contribution: PluginNavContribution) {
        validateLocalId(contribution.id)
        validatePath(contribution.path)
        if (contribution.icon) validateComponent(contribution.icon)
        return own(pluginUiRegistry.registerNav(pluginId, pluginName, contribution))
      },
      page(contribution: PluginPageContribution) {
        validateLocalId(contribution.id)
        validatePagePath(contribution.path)
        validateComponent(contribution.component)
        return own(pluginUiRegistry.registerPage(pluginId, pluginName, contribution))
      },
      panel(contribution: PluginPanelContribution) {
        validateLocalId(contribution.id)
        validateComponent(contribution.component)
        if (contribution.defaultSpan !== undefined && ![1, 2, 3].includes(contribution.defaultSpan)) {
          throw new Error('Plugin panel defaultSpan must be 1, 2, or 3')
        }
        if (contribution.order !== undefined && !Number.isFinite(contribution.order)) {
          throw new Error('Plugin panel order must be finite')
        }
        return own(pluginUiRegistry.registerPanel(pluginId, pluginName, contribution))
      },
      settings(contribution: PluginSettingsContribution) {
        validateLocalId(contribution.id)
        validateComponent(contribution.component)
        return own(pluginUiRegistry.registerSettings(pluginId, pluginName, contribution))
      },
      injectCss(css: string) {
        if (typeof css !== 'string') throw new Error('Plugin CSS must be a string')
        const style = document.createElement('style')
        style.dataset.walnutPlugin = pluginId
        style.textContent = css
        document.head.append(style)
        return own(disposable(() => { style.remove() }))
      },
      views: createPluginViews(pluginId),
    },
    get unsafe() {
      if (!unsafeWarned) {
        unsafeWarned = true
        pluginLog.warn('Plugin accessed unstable unsafe browser APIs')
      }
      return {
        react: globalThis.__WALNUT_PLUGIN_HOST__?.React,
        host: { registry: pluginUiRegistry },
        dom: document,
      }
    },
  }
}
