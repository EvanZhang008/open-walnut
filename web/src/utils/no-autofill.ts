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
