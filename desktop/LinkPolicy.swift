import Foundation

// MARK: - Link routing: pure policy
//
// The Mac app is ONE WKWebView showing the console. A browser gives a link three
// places to go (this tab, a new tab, another app); the shell has one window, so
// every "somewhere else" becomes "the default browser". What must never happen is
// the console itself navigating to an agent's dev server, a report, or a docs
// page: that throws away the SPA, its sockets, and whatever was in the composer.
//
// Foundation only: `scripts/test-desktop.sh` compiles this file into a plain
// test binary, so nothing here may touch AppKit or WebKit.

enum LinkVerdict: Equatable {
    /// Let WebKit load it where it was asked to (this frame).
    case inPage
    /// Hand the URL to macOS (default browser / the scheme's app) and cancel here.
    case openExternally
    /// Nothing to load (about:blank, an empty window.open) — cancel quietly.
    case ignore
}

struct LinkRequest {
    var url: URL
    /// WKNavigationType.linkActivated: the user clicked an anchor.
    var isLinkClick: Bool
    /// `targetFrame == nil`: `target="_blank"` or `window.open` asked for a new window.
    var targetsNewWindow: Bool
    /// The navigation is for the console's own frame, not an iframe inside it.
    var isMainFrame: Bool
}

struct LinkPolicy {
    /// Port the shell loaded the console from; with a loopback host it defines
    /// the app's own origin.
    var appPort: Int

    /// Schemes WebKit can load in-page. Everything else (vscode:, mailto:, x-apple…)
    /// is a "please open the app for this" request and arrives as `.other` when JS
    /// sets `location.href`, so navigation type is not consulted for them.
    static let inPageSchemes: Set<String> = ["http", "https", "about", "blob", "data", "javascript"]

    func isLoopback(_ host: String?) -> Bool {
        guard let host = host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    /// Same origin as the console: loopback host AND the console's port. The
    /// port matters: an agent's `http://localhost:5173` is another site, not
    /// another page of ours (comparing only the host is the bug that sent the
    /// whole console to the dev server).
    func isAppOrigin(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard isLoopback(url.host) else { return false }
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        return port == appPort
    }

    func verdict(for request: LinkRequest) -> LinkVerdict {
        let url = request.url
        let scheme = url.scheme?.lowercased() ?? ""
        if !LinkPolicy.inPageSchemes.contains(scheme) {
            return .openExternally
        }
        if request.targetsNewWindow {
            // A new window was asked for and the shell has none to give; the
            // default browser is the new window. about:blank / data: popups have
            // nothing worth showing outside.
            return (scheme == "http" || scheme == "https") ? .openExternally : .ignore
        }
        guard request.isLinkClick, scheme == "http" || scheme == "https" else {
            // SPA reloads, JS `location.href` to our own routes, iframe srcs.
            return .inPage
        }
        if request.isMainFrame {
            return isAppOrigin(url) ? .inPage : .openExternally
        }
        // Inside an iframe (an embedded editor on another localhost port, a letter
        // body): links to the wider internet leave the app, loopback links stay in
        // their frame — that frame IS that site.
        return isLoopback(url.host) ? .inPage : .openExternally
    }
}
