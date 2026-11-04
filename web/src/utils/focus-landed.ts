/**
 * Focus that a press moved somewhere shows where it went (2026-11-04 review of Remote Hosts:
 * after Add host, focus sat on the new link's Copy with no ring, because :focus-visible
 * follows the last input device and a mouse press turns it off, in WebKit and Chromium
 * alike). The element carries `data-landed` while it keeps that focus, and the stylesheet
 * rings it (settings-controls.css); the mark goes with the first blur.
 */
const FLASH_MS = 1500;

export function focusLanded(el: HTMLElement | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  if (!el.matches('button, input, select, textarea, a[href], [tabindex]')) el.setAttribute('tabindex', '-1');
  el.setAttribute('data-landed', 'true');
  const clear = () => { el.removeAttribute('data-landed'); el.removeEventListener('blur', clear); };
  el.addEventListener('blur', clear);
  el.focus({ preventScroll: true });
  if (document.activeElement === el) return true;
  clear();
  return false;
}

/** One 1.5 s outline on what a press made or showed (`rh-row-flash`), restarted on a second press. */
export function flashOnce(el: HTMLElement | null | undefined): void {
  if (!el) return;
  el.classList.remove('rh-row-flash');
  void el.offsetWidth; // restart the animation for a second request
  el.classList.add('rh-row-flash');
  window.setTimeout(() => el.classList.remove('rh-row-flash'), FLASH_MS);
}
