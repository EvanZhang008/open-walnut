/**
 * Puts plugin link handlers (link-handlers.ts) on every link in this window.
 *
 * Two document listeners in the CAPTURE phase, so they run before React's root
 * listener and before any surface's own anchor handler (LinkifiedText stops the
 * click's propagation; row menus open on a bubbling contextmenu):
 *   - a plain click on a link a plugin takes opens it in the plugin;
 *   - a right-click on one opens a Walnut menu: Open in <plugin>, Open in default
 *     browser, Copy link.
 * A link no plugin takes is untouched, so it keeps the browser's own click and menu.
 * A modifier click (Cmd/Ctrl/Shift/Alt), a middle click, a `download` link, a link
 * being edited, a click in a notes document (its editor opens its own links,
 * NotesEditor.tsx) and anything under `[data-native-link]` stay with the browser too.
 *
 * Frames are not reached by these listeners; the surfaces that own a frame forward
 * their links (`openExternalLink`, `showLinkMenu`): the Board and the HTML preview.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '@/components/common/ContextMenu'
import { closeModalOverlays } from '@/hooks/useModalOverlay'
import { afterPhoneOverlayBacks } from '@/hooks/usePhoneOverlayHistory'
import { isPopoutPath } from '@/popout/openPopout'
import { copyTextRobust } from '@/utils/clipboard'
import { log } from '@/utils/log'
import { createPressSelectionKeeper } from './link-menu-selection'
import {
  findLinkHandler,
  openInDefaultBrowser,
  openWithHandler,
  setLinkNavigate,
  type RegisteredLinkHandler,
} from './link-handlers'

interface LinkMenuState {
  point: ContextMenuPoint
  url: URL
  handler: RegisteredLinkHandler | null
  returnFocus: HTMLElement | null
}

let showMenuImpl: ((state: LinkMenuState) => void) | null = null

/**
 * Open the link menu for a link the caller found itself (a frame's link, with the
 * point already in this window's coordinates). A link no plugin takes gets the
 * browser and copy rows only. False when no host is mounted or the href is not http(s).
 */
export function showLinkMenu(href: string, point: ContextMenuPoint): boolean {
  if (!showMenuImpl) return false
  let url: URL
  try { url = new URL(href) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  showMenuImpl({ point, url, handler: findLinkHandler(url.href)?.handler ?? null, returnFocus: null })
  return true
}

/**
 * The anchor a plain click or right-click would act on, or null when it is not ours
 * to take. A click inside a ProseMirror document is the editor's, editable or not: it
 * opens links itself on mouseup (NotesEditor.tsx), and taking the click too would
 * open the link twice.
 */
export function capturableAnchor(target: EventTarget | null, gesture: 'click' | 'menu'): HTMLAnchorElement | null {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null
  const anchor = el?.closest?.('a[href]')
  if (!(anchor instanceof HTMLAnchorElement)) return null
  if (anchor.isContentEditable || anchor.hasAttribute('download') || anchor.closest('[data-native-link]')) return null
  if (gesture === 'click' && anchor.closest('.ProseMirror')) return null
  return anchor
}

function editorAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null
  const anchor = el?.closest?.('.ProseMirror a[href]')
  return anchor instanceof HTMLAnchorElement ? anchor : null
}

export function linkMenuItems(
  url: URL,
  handler: RegisteredLinkHandler | null,
): ContextMenuItem[] {
  return [
    {
      key: 'open-in-plugin',
      label: handler ? `Open in ${handler.title}` : '',
      when: !!handler,
      onSelect: () => { if (handler) openWithHandler(handler, url, 'menu') },
    },
    {
      key: 'open-in-browser',
      label: 'Open in default browser',
      onSelect: () => openInDefaultBrowser(url.href),
    },
    { divider: true },
    {
      key: 'copy-link',
      label: 'Copy link',
      onSelect: () => {
        void copyTextRobust(url.href).then((result) => {
          log.info('link-handlers', 'link copied', { result })
        })
      },
    },
  ]
}

export function LinkCaptureHost() {
  const routerNavigate = useNavigate()
  const [menu, setMenu] = useState<LinkMenuState | null>(null)

  useEffect(() => {
    setLinkNavigate((path: string) => {
      // A pop-out is one task or one session on its own; leaving it would lose it
      // (the same rule as PluginSlots), so the plugin opens in a window of its own.
      if (isPopoutPath(window.location.pathname)) {
        window.open(path, '_blank')
        return
      }
      // A modal the link was in would stay on top of the App it opens. On a phone
      // closing it is a history back, and a push made before it lands is undone.
      closeModalOverlays()
      afterPhoneOverlayBacks(() => routerNavigate(path))
    })
    return () => setLinkNavigate(null)
  }, [routerNavigate])

  useEffect(() => {
    showMenuImpl = setMenu
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const anchor = capturableAnchor(e.target, 'click')
      if (!anchor) {
        // A read-only note's link is a real `target=_blank` link: its editor already
        // opened it in the plugin on mouseup, so the click must not open a tab too.
        const inNote = editorAnchor(e.target)
        if (inNote && findLinkHandler(inNote.href)) e.preventDefault()
        return
      }
      const found = findLinkHandler(anchor.href)
      if (!found) return
      e.preventDefault()
      e.stopPropagation()
      openWithHandler(found.handler, found.url, 'click')
    }
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return
      const anchor = capturableAnchor(e.target, 'menu')
      if (!anchor) return
      const found = findLinkHandler(anchor.href)
      if (!found) return
      e.preventDefault()
      e.stopPropagation()
      // WebKit has already selected the link's word; that is not the user's selection.
      keeper.settle()
      setMenu({ point: { x: e.clientX, y: e.clientY }, url: found.url, handler: found.handler, returnFocus: anchor })
    }
    const keeper = createPressSelectionKeeper(() => window.getSelection())
    const onPress = (e: PointerEvent) => keeper.press(e)
    document.addEventListener('pointerdown', onPress, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => {
      if (showMenuImpl === setMenu) showMenuImpl = null
      document.removeEventListener('pointerdown', onPress, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('contextmenu', onContextMenu, true)
    }
  }, [])

  const close = useCallback(() => setMenu(null), [])
  if (!menu) return null
  return (
    <ContextMenu
      point={menu.point}
      items={linkMenuItems(menu.url, menu.handler)}
      onClose={close}
      ariaLabel="Link actions"
      testId="link-ctx-menu"
      returnFocus={menu.returnFocus}
    />
  )
}
