import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'

export interface WalnutPluginHostRuntime {
  React: typeof React
  ReactDOM: typeof ReactDOM & typeof ReactDOMClient
  jsxRuntime: typeof jsxRuntime
  jsxDevRuntime: typeof jsxDevRuntime
}

declare global {
  var __WALNUT_PLUGIN_HOST__: WalnutPluginHostRuntime | undefined
}

export function installPluginHostRuntime(): WalnutPluginHostRuntime {
  const runtime: WalnutPluginHostRuntime = {
    React,
    ReactDOM: { ...ReactDOM, ...ReactDOMClient },
    jsxRuntime,
    jsxDevRuntime,
  }
  globalThis.__WALNUT_PLUGIN_HOST__ = runtime
  return runtime
}
