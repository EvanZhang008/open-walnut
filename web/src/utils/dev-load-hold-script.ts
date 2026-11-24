/**
 * The dev server only (the browser specs run on it): a pending module script holds the page's
 * load event, which a dynamic import never does. Each step that imports the next part of the
 * console late (boot.ts imports main, boot-shell.ts imports App) adds one for that part, by the
 * address the import uses, so it is the same module, fetched and run once. It must be added while
 * the page still loads: a module that first runs after `load` holds nothing (2026-11-24: boot.ts
 * imported main only after `load`, so boot-shell's hold for App was never added and `load` came at
 * 0.15 s while the app's socket opened at 6.8 s). A build loads its few chunks at once and adds none.
 */
export function holdDevLoad(src: string): void {
  if (!import.meta.env.DEV || document.readyState === 'complete') return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = src;
  document.head.appendChild(script);
}
