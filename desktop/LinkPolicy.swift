import Foundation

// Foundation only: link routing can be tested without AppKit or WebKit.

enum LinkVerdict: Equatable {
    /// Let WebKit load it where it was asked to (this frame).
    case inPage
    case openInAppWindow
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

    func isSameWindowTarget(_ current: URL, _ requested: URL) -> Bool {
        guard isAppOrigin(current), isAppOrigin(requested),
              current.path == "/popout", requested.path == "/popout",
              let a = URLComponents(url: current, resolvingAgainstBaseURL: false),
              let b = URLComponents(url: requested, resolvingAgainstBaseURL: false) else {
            return current == requested
        }
        let view = a.queryItems?.first { $0.name == "view" }?.value
        guard view == "session" || view == "task",
              view == b.queryItems?.first(where: { $0.name == "view" })?.value,
              let id = a.queryItems?.first(where: { $0.name == "id" })?.value, !id.isEmpty else {
            return current == requested
        }
        return id == b.queryItems?.first(where: { $0.name == "id" })?.value
    }

    func verdict(for request: LinkRequest) -> LinkVerdict {
        let url = request.url
        let scheme = url.scheme?.lowercased() ?? ""
        if !LinkPolicy.inPageSchemes.contains(scheme) {
            return .openExternally
        }
        if request.targetsNewWindow {
            if isAppOrigin(url) { return .openInAppWindow }
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
