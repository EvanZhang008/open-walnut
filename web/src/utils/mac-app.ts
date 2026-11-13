/**
 * Is this page running in the Mac app? Its WKWebView (desktop/main.swift) carries Walnut's own
 * message handlers, and a browser never has any of them. The ONE check every surface reads: the
 * keyboard hints, the input latency monitor, the installed-app update and the mail attachment saver.
 */

/** Older app builds carry only some of these, so any one of them is the app. */
const APP_HANDLERS = ['walnutChrome', 'walnutClipboard', 'walnutUpdate'] as const;

/** The web view's message handlers, when there are any. */
export function macAppHandlers(w: Window = window): Record<string, unknown> | undefined {
  return (w as Window & { webkit?: { messageHandlers?: Record<string, unknown> } }).webkit?.messageHandlers;
}

export function inMacApp(w: Window = window): boolean {
  const handlers = macAppHandlers(w);
  return !!handlers && APP_HANDLERS.some((name) => name in handlers);
}
