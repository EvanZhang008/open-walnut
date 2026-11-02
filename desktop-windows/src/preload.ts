/**
 * The bridge the app's own pages (setup, loading, This PC) use. The console and any page it
 * links to get nothing: the bridge is exposed only on file:// pages, and main.ts checks the
 * calling frame again.
 */
import { contextBridge, ipcRenderer } from 'electron'

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('walnutApp', {
    startSetup: (mode: 'own' | 'join', invite?: string) => ipcRenderer.invoke('setup:start', mode, invite ?? ''),
    clipboardInvite: () => ipcRenderer.invoke('setup:clipboard-invite'),
    onSetupLine: (cb: (v: { line: string; stage: string | null }) => void) => { ipcRenderer.on('setup:line', (_e, v) => cb(v)) },
    onSetupEnd: (cb: (v: { end: 'done' | 'restart' | 'failed'; code: number | null; mode: 'own' | 'join' }) => void) => { ipcRenderer.on('setup:end', (_e, v) => cb(v)) },
    continue: () => ipcRenderer.invoke('app:continue'),
    info: () => ipcRenderer.invoke('app:info'),
    retryConsole: () => ipcRenderer.invoke('console:retry'),
    setupAgain: () => ipcRenderer.invoke('app:setup-again'),
    pcStatus: () => ipcRenderer.invoke('pc:status'),
    openWalnut: () => ipcRenderer.invoke('pc:open-walnut'),
  })
}
