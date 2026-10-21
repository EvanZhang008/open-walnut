import Foundation

// External pages must not replace the console or its unsent drafts.
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

        precondition(policy.verdict(for: req("https://example.com/", newWindow: true)) == .openExternally)
        precondition(policy.verdict(for: req("http://localhost:5173/popout", newWindow: true)) == .openExternally)
        precondition(policy.verdict(for: req("http://localhost:3456/tasks", click: false, newWindow: true)) == .openInAppWindow)
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            for view in ["session", "file", "note", "task", "global-notes"] {
                let url = "http://\(host):3456/popout?view=\(view)&id=abc&path=%2Fa%20b%2Ffile.md"
                precondition(policy.verdict(for: req(url, newWindow: true)) == .openInAppWindow)
            }
        }
        precondition(LinkPolicy(appPort: 4567).verdict(for: req("http://localhost:4567/popout", newWindow: true)) == .openInAppWindow)
        precondition(policy.verdict(for: req("http://localhost.example.com:3456/popout", newWindow: true)) == .openExternally)
        precondition(policy.verdict(for: req("about:blank", click: false, newWindow: true)) == .ignore)
        precondition(policy.verdict(for: req("data:text/html,test", newWindow: true)) == .ignore)
        precondition(policy.verdict(for: req("blob:http://localhost:3456/abc", newWindow: true)) == .ignore)

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

        let session = URL(string: "http://localhost:3456/popout?view=session&id=abc")!
        precondition(policy.isSameWindowTarget(session, URL(string: "http://localhost:3456/popout?view=session&id=abc&cwd=%2Fworkspace&host=local")!))
        precondition(!policy.isSameWindowTarget(session, URL(string: "http://localhost:3456/popout?view=session&id=other")!))
        precondition(!policy.isSameWindowTarget(session, URL(string: "http://localhost:3456/popout?view=task&id=abc")!))
        precondition(!policy.isSameWindowTarget(session, URL(string: "http://example.com:3456/popout?view=session&id=abc")!))
        precondition(!policy.isSameWindowTarget(URL(string: "http://localhost:3456/popout?view=file&path=a&line=1")!, URL(string: "http://localhost:3456/popout?view=file&path=a&line=2")!))
        print("LinkPolicyTests: all passed")
    }
}
