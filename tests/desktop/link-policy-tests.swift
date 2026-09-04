import Foundation

/// LinkPolicy (desktop/LinkPolicy.swift): where a link clicked in the Mac app's
/// single WKWebView goes. The failure this guards: a link to a dev server, a
/// report, or a docs page replacing the console itself (2026-09-03 report,
/// "links open in place instead of another window").
@main
struct LinkPolicyTests {
    static func main() {
        let policy = LinkPolicy(appPort: 3456)

        func req(_ s: String, click: Bool = true, newWindow: Bool = false, main: Bool = true) -> LinkRequest {
            LinkRequest(url: URL(string: s)!, isLinkClick: click, targetsNewWindow: newWindow, isMainFrame: main)
        }

        // Our own routes stay in the app: absolute or not, either loopback name.
        precondition(policy.verdict(for: req("http://localhost:3456/tasks/abc")) == .inPage)
        precondition(policy.verdict(for: req("http://127.0.0.1:3456/")) == .inPage)
        precondition(policy.isAppOrigin(URL(string: "http://localhost:3456/x?y=1#z")!))

        // Another port on localhost is another site: an agent's dev server, a
        // Playwright report, an embedded editor. This was the bug.
        precondition(policy.verdict(for: req("http://localhost:5173/")) == .openExternally)
        precondition(policy.verdict(for: req("http://localhost:9323/report")) == .openExternally)
        precondition(!policy.isAppOrigin(URL(string: "http://localhost/")!))

        // The wider internet leaves the app on a click.
        precondition(policy.verdict(for: req("https://example.com/docs")) == .openExternally)

        // target="_blank" / window.open asked for a new window; the default
        // browser is the new window, even for our own origin.
        precondition(policy.verdict(for: req("https://example.com/", newWindow: true)) == .openExternally)
        precondition(policy.verdict(for: req("http://localhost:3456/tasks", click: false, newWindow: true)) == .openExternally)
        precondition(policy.verdict(for: req("about:blank", click: false, newWindow: true)) == .ignore)

        // Non-link navigations (SPA reload, JS location.href, iframe src) load in place.
        precondition(policy.verdict(for: req("http://localhost:3456/settings", click: false)) == .inPage)
        precondition(policy.verdict(for: req("https://cdn.example.com/embed", click: false, main: false)) == .inPage)

        // Non-web schemes always go to macOS, whatever the navigation type.
        precondition(policy.verdict(for: req("vscode://file/x.ts", click: false)) == .openExternally)
        precondition(policy.verdict(for: req("mailto:a@b.co")) == .openExternally)

        // Inside an iframe: an embedded editor on another loopback port keeps its
        // own links; internet links still leave the app.
        precondition(policy.verdict(for: req("http://localhost:8443/?folder=x", main: false)) == .inPage)
        precondition(policy.verdict(for: req("https://example.com/", main: false)) == .openExternally)

        print("LinkPolicyTests: all passed")
    }
}
