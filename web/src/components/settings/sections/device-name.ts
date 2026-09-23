/**
 * The server keeps device names as ids: 1 to 64 letters, digits, dots, dashes
 * and underscores, starting with a letter or digit (src/core/device-auth.ts).
 * People type "My iPhone", so the name is made to fit before it is sent
 * instead of answering with the rule (N3-03). Pure, unit tested.
 */
export const DEVICE_NAME_RULE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** "My iPhone" -> "My-iPhone"; null when nothing usable is left. */
export function deviceNameForServer(typed: string): string | null {
  const slug = typed
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[-.]+$/, '');
  return DEVICE_NAME_RULE.test(slug) ? slug : null;
}
