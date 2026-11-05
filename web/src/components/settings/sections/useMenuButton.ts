/**
 * A button that opens a menu (Remote Hosts' Add host, a row's More): the ONE owner of the menu's
 * open and closed state, so every mouse and keyboard path does the same thing every time
 * (2026-11-05 review: from the keyboard Add host opened nothing, or opened and closed itself
 * within half a second, about one try in three; ArrowDown to the second item and Enter opened the
 * menu again at its first item instead of picking it).
 *
 * The cause was a deferred focus move: a close handed the focus back to the button one frame
 * later "if it fell", and counted a focus inside the menu as fallen. When the next open came
 * before that frame (WebKit under load spaces frames half a second apart), the frame took the
 * focus out of the NEW menu, whose blur then closed it. Every close and open now bumps a
 * generation, and a deferred move runs only while nothing opened since.
 *
 * Also here: a press on the button while its menu is open closes it and stays closed (the menu's
 * backdrop takes the press and closes the menu; WebKit then delivered the click to the button,
 * which opened it again), and Enter, Space or ArrowDown on the closed button opens it with its
 * first item highlighted, on the key going down (WebKit makes Space's click as the key comes up).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { keepPress } from '../inputs/press-keeps-target';

export interface MenuAt { x: number; y: number; keys: boolean }
/** Why a menu closed: `anchor` = a press on its own button (through the backdrop). */
export type MenuCloseWhy = 'anchor' | undefined;

/** The focus fell to the page (the element that held it went away; WebKit may still name it). */
const fell = () => {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
};

export interface MenuButton {
  menu: MenuAt | null;
  /** Spread on the button. */
  buttonProps: {
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    onClick: (e: React.MouseEvent<HTMLElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
    /** A press keeps the button even if the row moves under it before the release. */
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  };
  /** The menu's `onClose`. `land`: where the focus goes when the close leaves it nowhere (default: the button). */
  close: (why?: MenuCloseWhy) => void;
}

export function useMenuButton(buttonOf: () => HTMLElement | null, land?: (button: HTMLElement | null) => void): MenuButton {
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const open = useRef(false);
  open.current = !!menu;
  // Bumped on every open and close: a deferred focus move runs only for the close that made it.
  const gen = useRef(0);
  // The click that follows a press which closed the menu through its backdrop (WebKit sends it
  // to the button under the backdrop): swallowed, once. A new press or key ends it, so a click
  // that never comes (Chromium sends none) swallows nothing later.
  const swallow = useRef(false);
  const landRef = useRef(land);
  landRef.current = land;
  useEffect(() => {
    const end = () => { swallow.current = false; };
    document.addEventListener('pointerdown', end, true);
    document.addEventListener('keydown', end, true);
    return () => {
      document.removeEventListener('pointerdown', end, true);
      document.removeEventListener('keydown', end, true);
    };
  }, []);

  const openAt = useCallback((el: HTMLElement, keys: boolean) => {
    gen.current += 1;
    const r = el.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 4, keys });
  }, []);

  const close = useCallback((why?: MenuCloseWhy) => {
    if (!open.current) return;
    gen.current += 1;
    const mine = gen.current;
    if (why === 'anchor') swallow.current = true;
    const button = buttonOf();
    const back = () => { if (landRef.current) landRef.current(buttonOf()); else buttonOf()?.focus({ preventScroll: true }); };
    // A focus inside the menu goes with it: back on the button at once, while the button still
    // stands where it stood (a frame later, WebKit had moved it into the sticky bar).
    const a = document.activeElement;
    const inMenu = !!a && a !== button && !!a.closest('[role="menu"]');
    if (why === 'anchor' || fell() || inMenu) back();
    open.current = false;
    setMenu(null);
    // A focus that fell meanwhile (a press on blank page) comes back a frame later, unless the
    // menu opened again since (the review's bug: this frame used to close the new menu).
    requestAnimationFrame(() => { if (gen.current === mine && fell()) back(); });
  }, [buttonOf]);

  const buttonProps: MenuButton['buttonProps'] = {
    'aria-haspopup': 'menu',
    'aria-expanded': !!menu,
    onClick: (e) => {
      if (swallow.current) { swallow.current = false; return; }
      if (open.current) { close(); return; }
      // A click the keyboard made (a screen reader's) has no pointer: `detail` is 0.
      openAt(e.currentTarget, e.detail === 0);
    },
    onKeyDown: (e) => {
      if (open.current || !(e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) return;
      e.preventDefault();
      openAt(e.currentTarget, true);
    },
    onPointerDown: (e) => { if (!open.current) keepPress(e.currentTarget, e); },
  };
  return { menu, buttonProps, close };
}
