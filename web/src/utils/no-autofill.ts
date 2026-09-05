/**
 * Spread onto free-text inputs/textareas (chat composers, quick-add boxes) so
 * password managers don't misread them as login fields and pop an autofill
 * prompt over the UI (seen with iCloud Passwords on the session composer).
 * autoComplete="off" covers Safari/Chrome heuristics + Apple's extension; the
 * data-* flags are the documented opt-outs for 1Password / LastPass /
 * Bitwarden / Dashlane.
 */
export const NO_AUTOFILL_PROPS = {
  autoComplete: 'off',
  'data-1p-ignore': '',
  'data-lpignore': 'true',
  'data-bwignore': '',
  'data-form-type': 'other',
} as const;

/**
 * Blanket coverage: stamp the same opt-outs onto EVERY input/textarea in the
 * document — current and future (MutationObserver) — so no field anywhere in
 * the app triggers a password-manager popup. Walnut has no login form, so a
 * global suppression is safe. Attributes already present are left untouched
 * (React never diffs attributes it didn't render, so external stamping sticks).
 */
/**
 * iCloud Passwords ignores every opt-out above and pops its completion list
 * ("Enable Password AutoFill") straight over the composer.
 *
 * Read out of the extension's own content_script.js: `_isTextField()` returns
 * true for EVERY <textarea>, so the message box is a fill candidate, and
 * `autocomplete="off"` is only forwarded to the native app as a
 * `DisallowsAutocomplete` flag which Apple's AutoFill deliberately ignores. So
 * there is nothing markup-side left to set: the panel has to be hidden.
 *
 * It is identifiable without guessing, because the extension builds it the same
 * way every time: a bare <div> appended to <body>, popover="manual", an OPEN
 * shadow root, and inside it one <iframe> pointing at the extension's own
 * completion_list.html. Nothing else on a page looks like that. Walnut has no
 * login form, so there is never a credential here worth filling.
 */
function isPasswordManagerOverlay(el: Element): boolean {
  if (el.tagName !== 'DIV') return false;
  const root = (el as HTMLElement).shadowRoot;
  if (!root) return false;
  const src = root.querySelector('iframe')?.getAttribute('src') ?? '';
  return /^(?:moz|chrome|safari-web)-extension:\/\//i.test(src) && /\/completion_list\.html(?:[?#]|$)/i.test(src);
}

/**
 * Hidden rather than removed: the extension keeps its own reference to the node
 * and re-styles it (opacity, visibility) when it shows, so deleting it out from
 * under it invites an add/remove ping-pong. An inline `display: none` wins over
 * everything it sets and survives the show path untouched.
 */
function hidePasswordManagerOverlay(el: Element): void {
  const host = el as HTMLElement & { hidePopover?: () => void };
  host.style.setProperty('display', 'none', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  if (typeof host.hidePopover === 'function' && host.hasAttribute('popover')) {
    try { host.hidePopover(); } catch { /* not showing; nothing to hide */ }
  }
}

export function installGlobalAutofillSuppression(): void {
  // Text-entry fields only. Checkboxes/radios/etc. never trigger autofill, and
  // stamping them is actively harmful: a checkbox inside a ProseMirror editor
  // (notes task list) is owned by PM's own MutationObserver — our setAttribute
  // makes PM re-render the node, the fresh <input> re-triggers our observer,
  // and the two observers ping-pong forever (700k mutations/4s, froze the
  // whole app — 2026-08-13 incident).
  const TEXT_FIELDS =
    'textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="number"], input[type="password"]';
  const stamp = (el: Element) => {
    // Never touch editor-owned DOM (ProseMirror/contenteditable) — see above.
    if (el.closest('.ProseMirror, [contenteditable="true"]')) return;
    if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    if (!el.hasAttribute('data-1p-ignore')) el.setAttribute('data-1p-ignore', '');
    if (!el.hasAttribute('data-lpignore')) el.setAttribute('data-lpignore', 'true');
    if (!el.hasAttribute('data-bwignore')) el.setAttribute('data-bwignore', '');
    if (!el.hasAttribute('data-form-type')) el.setAttribute('data-form-type', 'other');
  };
  const scan = (root: Element) => {
    if (isPasswordManagerOverlay(root)) hidePasswordManagerOverlay(root);
    if (root.matches(TEXT_FIELDS)) stamp(root);
    for (const el of root.querySelectorAll(TEXT_FIELDS)) stamp(el);
  };
  scan(document.documentElement);
  // Cheap per-batch work: text-node mutations (streaming output) are filtered
  // by the instanceof check; element subtrees are scanned with one query each.
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n instanceof Element) scan(n);
      }
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
}
