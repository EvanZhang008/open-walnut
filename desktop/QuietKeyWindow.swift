import Cocoa

/// Every window Walnut and the Demo app make for a web view (and every one their native tests
/// make). A key the page leaves unhandled travels up the responder chain to the window, whose
/// default answer is NSBeep: an Escape, Enter or arrow press on a part of the page that takes no text played the
/// alert sound, and a native test driver sending such keys played it on every run (2026-11-08,
/// heard through the night). A browser plays nothing there, so neither does this window; every
/// other unhandled action keeps AppKit's own answer. tests/desktop/quiet-window.test.ts fails on
/// a window made any other way.
final class QuietKeyWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)) { return }
        super.noResponder(for: eventSelector)
    }
}
