/** WebKit itself (Safari, the Mac app's WKWebView), not a Chromium browser that also names AppleWebKit. */
export function isWebKitEngine(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
}

/**
 * WebKit on a Mac desktop (the Mac app, Safari on a Mac), not an iPhone or an iPad: an iPad names
 * Macintosh too, but has touch points.
 */
export function isMacDesktopWebKit(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
  touchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints ?? 0,
): boolean {
  return isWebKitEngine(ua) && /Macintosh/.test(ua) && touchPoints === 0;
}
