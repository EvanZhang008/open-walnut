import SwiftUI
import WebKit

/// An agent-written HTML letter body, rendered inline in the reader.
///
/// Security posture — the letter body is the ONE piece of a letter that is
/// arbitrary agent-authored markup, and it is read blind on a phone, so this is
/// the email-client model, not the file-preview model (`HTMLFilePreview`, which
/// deliberately keeps JavaScript on for the owner's own generated reports):
///
/// - **JavaScript OFF** (`allowsContentJavaScript = false`). A letter is a
///   document; nothing in one needs to run code.
/// - **`baseURL: nil`** so no relative reference can resolve to anything, on
///   this server or elsewhere.
/// - **CSP `default-src 'none'`** with only `data:`/`blob:` images and media
///   plus inline styles allowed. Without it a tracker pixel in a letter would
///   report the exact moment (and IP) the human read it. Declared as a `<meta>`
///   because that is honoured for every load, `loadHTMLString` included.
///   `media-src` is what lets a daily digest embed its podcast as
///   `<audio src="data:audio/mpeg;base64,…">`: under `default-src 'none'` the
///   player renders and silently refuses to play. Still no network — an
///   `https://` media URL stays blocked, so opening a letter reveals nothing.
/// - **Navigation lockdown**: only the initial in-memory document ever renders.
///   A real link tap opens in Safari; every other navigation is cancelled.
/// - **Ephemeral data store**: nothing is persisted or shared with the app's
///   own session.
///
/// The web console's reader takes the same posture with a sandboxed iframe
/// (no `allow-scripts`, no `allow-same-origin`, same CSP), so a letter looks and
/// behaves the same on both surfaces.
struct LetterHTMLBody: View {
    /// The document source. A small body arrives inline in the letter JSON; a big
    /// one (over the server's inline threshold) is streamed to a local file first
    /// — see LetterBodyDownload — because a 100MB digest must never be resident as
    /// a Swift String on the way into the web view.
    enum Source: Equatable {
        case inline(String)
        case file(URL)
    }

    let source: Source

    @State private var height: CGFloat = 60

    init(html: String) { self.source = .inline(html) }
    init(fileURL: URL) { self.source = .file(fileURL) }

    var body: some View {
        LetterHTMLWebView(source: webViewSource, height: $height)
            .frame(height: height)
            .accessibilityIdentifier("inbox.letter.htmlBody")
    }

    /// An inline body is wrapped here; a file was already assembled complete
    /// (prelude + body + suffix) when it was downloaded, so it loads as-is.
    private var webViewSource: LetterHTMLWebView.Source {
        switch source {
        case .inline(let html): return .document(Self.document(wrapping: html))
        case .file(let url): return .file(url)
        }
    }

    /// The letter body's security floor, in one place so a test can pin it:
    /// no JavaScript, nothing persisted. Never relax either.
    static func webViewConfiguration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        // A `<video>` in a digest must play WHERE IT SITS. This defaults to false
        // on iOS, which makes WebKit refuse to start a clip in place and hand it
        // to the fullscreen player instead — and with scripting off there is
        // nothing in the document that could ask for fullscreen, so the clip just
        // does nothing when tapped. Audio was never affected, which is why this
        // only showed up once letters started carrying video.
        config.allowsInlineMediaPlayback = true
        // Playback still requires the human to tap: no autoplay, and therefore no
        // letter that starts making noise the moment it is opened.
        config.mediaTypesRequiringUserActionForPlayback = .all
        return config
    }

    /// Wrap the agent's markup in a phone-shaped document: a viewport, the CSP,
    /// and typography that matches the rest of the app. The agent's HTML is
    /// dropped in verbatim — no rewriting, so nothing about the letter changes
    /// meaning on the way in.
    static func document(wrapping body: String) -> String {
        let (prelude, suffix) = documentPieces()
        return prelude + body + suffix
    }

    /// The same document, split so a streamed body can be written BETWEEN the two
    /// halves instead of concatenated in memory (LetterBodyDownload). One source
    /// for both paths: a second copy would let a big letter render under a weaker
    /// CSP than a small one.
    static func documentPieces() -> (prelude: String, suffix: String) {
        let prelude = """
        <!DOCTYPE html><html><head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:">
        <style>
        :root { color-scheme: light dark; }
        html, body { margin: 0; padding: 0; background: transparent; }
        body {
          font: -apple-system-body;
          font-family: -apple-system, system-ui, sans-serif;
          line-height: 1.45;
          color: #1c1c1e;
          word-break: break-word;
          -webkit-text-size-adjust: 100%;
        }
        a { color: #8B5A2B; }
        h1, h2, h3, h4 { line-height: 1.25; margin: 1em 0 0.4em; }
        h1 { font-size: 1.35em; } h2 { font-size: 1.2em; } h3 { font-size: 1.08em; }
        p, ul, ol, blockquote, table { margin: 0.55em 0; }
        img, video, svg { max-width: 100%; height: auto; }
        audio { width: 100%; }
        pre, code, kbd { font-family: ui-monospace, Menlo, monospace; font-size: 0.88em; }
        pre { overflow-x: auto; padding: 8px 10px; border-radius: 8px; background: rgba(120,120,128,0.16); }
        code { padding: 1px 4px; border-radius: 4px; background: rgba(120,120,128,0.16); }
        blockquote { padding-left: 10px; border-left: 3px solid rgba(120,120,128,0.4); color: #3c3c43; }
        table { border-collapse: collapse; display: block; overflow-x: auto; }
        th, td { border: 1px solid rgba(120,120,128,0.35); padding: 4px 7px; text-align: left; }
        hr { border: none; border-top: 1px solid rgba(120,120,128,0.35); margin: 1em 0; }
        @media (prefers-color-scheme: dark) {
          body { color: #f2f2f7; }
          a { color: #C99659; }
          blockquote { color: #c7c7cc; }
        }
        </style>
        </head><body>

        """
        return (prelude, "\n</body></html>\n")
    }
}

/// The web view itself: fixed to its content height (the enclosing SwiftUI
/// ScrollView does the scrolling, so a nested scroller would fight it).
private struct LetterHTMLWebView: UIViewRepresentable {
    enum Source: Equatable {
        case document(String)
        case file(URL)

        /// Cheap identity for updateUIView's "did the content change" check —
        /// comparing whole 100MB documents on every SwiftUI update would not be.
        var key: String {
            switch self {
            case .document(let doc): return "d:\(doc.count):\(doc.prefix(64))"
            case .file(let url): return "f:\(url.path)"
            }
        }
    }

    let source: Source
    @Binding var height: CGFloat

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: LetterHTMLBody.webViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        context.coordinator.observe(webView)
        load(source, into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedKey != source.key else { return }
        context.coordinator.loadedKey = source.key
        load(source, into: webView)
    }

    private func load(_ source: Source, into webView: WKWebView) {
        switch source {
        case .document(let doc):
            // baseURL nil: relative references resolve to nothing at all.
            webView.loadHTMLString(doc, baseURL: nil)
        case .file(let url):
            // Read access is granted to the FILE only, not its directory, so the
            // document cannot reach any other letter's cached body. The CSP in the
            // document still forbids every subresource except data:/blob:, so a
            // file:// origin buys the letter nothing.
            webView.loadFileURL(url, allowingReadAccessTo: url)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self, key: source.key) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: LetterHTMLWebView
        var loadedKey: String
        private var observation: NSKeyValueObservation?

        init(_ parent: LetterHTMLWebView, key: String) {
            self.parent = parent
            self.loadedKey = key
        }

        /// Content height WITHOUT JavaScript: `scrollView.contentSize` is laid
        /// out by WebKit regardless of scripting, and KVO catches the late
        /// growth when data-URI images finish decoding.
        func observe(_ webView: WKWebView) {
            observation = webView.scrollView.observe(\.contentSize, options: [.new]) { [weak self] scrollView, _ in
                self?.report(height: scrollView.contentSize.height)
            }
        }

        /// The 1pt tolerance matters: assigning the height resizes the web view,
        /// which fires contentSize again — without a dead band that is a render
        /// loop rather than a measurement.
        private func report(height: CGFloat) {
            guard height > 0 else { return }
            let rounded = ceil(height)
            Task { @MainActor in
                if abs(parent.height - rounded) > 1 { parent.height = rounded }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            report(height: webView.scrollView.contentSize.height)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // Sub-frames can't navigate the reader away; let them settle.
            guard navigationAction.targetFrame?.isMainFrame != false else {
                decisionHandler(.allow)
                return
            }
            let url = navigationAction.request.url
            // The in-memory document itself (loadHTMLString has no real URL),
            // or the local file the streamed-body path assembled for us.
            if url == nil || url?.scheme == nil || url?.scheme == "about" || url?.isFileURL == true {
                decisionHandler(.allow)
                return
            }
            // A real tap on a link opens in Safari. Everything else — meta
            // refresh, form posts, any redirect — is dropped, so the body can
            // never navigate to another page.
            if navigationAction.navigationType == .linkActivated,
               let url, url.scheme == "http" || url.scheme == "https" {
                Task { @MainActor in UIApplication.shared.open(url) }
            }
            decisionHandler(.cancel)
        }
    }
}
