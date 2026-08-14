import SwiftUI
import WebKit

/// Deep-link representation of "open this server-side file in the in-app
/// preview". Timeline text turns bare absolute `.html` paths into links
/// carrying this custom scheme (mirror of how bare image paths inline via
/// MarkdownParser.splitBarePathImages); the timeline intercepts the tap and
/// opens the WKWebView preview sheet instead of handing the URL to iOS.
enum FilePreviewLink {
    static let scheme = "walnut-file"

    /// Extensions the in-app preview renders as a WKWebView document.
    static func isPreviewablePath(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension.lowercased()
        return ext == "html" || ext == "htm"
    }

    /// walnut-file://preview/tmp/report.html — URLComponents percent-encodes
    /// spaces and friends, so any absolute Unix path round-trips.
    static func url(for path: String) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = "preview"
        components.path = path
        return components.url
    }

    /// The file path carried by a preview link. Accepts our custom scheme and
    /// scheme-less absolute .html paths (a markdown link like
    /// `[report](/tmp/report.html)` parses to a URL with no scheme).
    static func path(from url: URL) -> String? {
        let path = url.path(percentEncoded: false)
        if url.scheme == scheme { return path }
        if (url.scheme ?? "").isEmpty, path.hasPrefix("/"), isPreviewablePath(path) {
            return path
        }
        return nil
    }
}

/// Sheet-presentation payload for the preview (path + which host's disk).
struct FilePreviewTarget: Identifiable {
    let path: String
    /// nil/"" = the primary box; otherwise the session's exec-host alias.
    let host: String?
    var id: String { "\(host ?? "")\u{1}\(path)" }
}

enum HTMLPreviewPhase: Equatable {
    case loading
    case loaded
    case failed(String)
}

/// Server-side HTML file rendered in a sandboxed WKWebView — the phone-side
/// mirror of the web console's preview iframe (both load the same raw
/// file-content URL, so semantics and the path sandbox match).
///
/// Security posture: the content is the owner's own generated file, so
/// JavaScript stays ON — most generated reports need it to be useful.
/// Isolation comes from the container instead:
/// - non-persistent WKWebsiteDataStore: no cookies/storage shared with
///   anything or kept after dismiss
/// - navigation lockdown: the web view only ever displays the initial URL.
///   Link taps to http(s) open in Safari; every other navigation (JS
///   redirects included) is cancelled, so the preview can never be steered
///   to another page or another server-side file.
struct HTMLFilePreview: View {
    let path: String
    let host: String?

    @State private var phase: HTMLPreviewPhase = .loading

    var body: some View {
        ZStack {
            if let url = WalnutAPI.rawFileContentURL(path: path, host: host) {
                HTMLPreviewWebView(url: url, token: AppConfig.token, phase: $phase)
                if phase == .loading {
                    ProgressView()
                        .controlSize(.large)
                }
                if case .failed(let message) = phase {
                    ContentUnavailableView {
                        Label("Can't preview file", systemImage: "doc.richtext")
                    } description: {
                        Text(message)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            } else {
                ContentUnavailableView {
                    Label("Not connected", systemImage: "wifi.slash")
                } description: {
                    Text("Pair with your Walnut server to preview files.")
                }
            }
        }
        .accessibilityIdentifier("file.htmlPreview")
    }
}

/// Standalone sheet wrapper (timeline link taps) — same toolbar shape as the
/// file viewer: share + Done.
struct HTMLFilePreviewSheet: View {
    let path: String
    let host: String?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            HTMLFilePreview(path: path, host: host)
                .navigationTitle((path as NSString).lastPathComponent)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        if let url = WalnutAPI.rawFileContentURL(path: path, host: host) {
                            ShareLink(item: url)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

/// The WKWebView itself. Loads the authenticated raw file-content URL (Bearer
/// header on the main-document request — same credential the image pipeline
/// sends) and reports load state through `phase`.
private struct HTMLPreviewWebView: UIViewRepresentable {
    let url: URL
    let token: String?
    @Binding var phase: HTMLPreviewPhase

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Ephemeral store: nothing persisted, no cookie jar shared with the
        // app's URLSession or other previews.
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        var request = URLRequest(url: url)
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        webView.load(request)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let parent: HTMLPreviewWebView

        init(_ parent: HTMLPreviewWebView) { self.parent = parent }

        private func setPhase(_ phase: HTMLPreviewPhase) {
            // Never overwrite a friendly failure (set by the response check)
            // with the generic "cancelled" error our own .cancel produces.
            if case .failed = parent.phase { return }
            Task { @MainActor in parent.phase = phase }
        }

        /// Initial document, ignoring fragment (in-page anchors must work).
        private func isInitialDocument(_ url: URL?) -> Bool {
            guard let url else { return false }
            var a = URLComponents(url: url, resolvingAgainstBaseURL: false)
            var b = URLComponents(url: parent.url, resolvingAgainstBaseURL: false)
            a?.fragment = nil
            b?.fragment = nil
            return a?.url == b?.url
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Sub-frames may load their own content (embeds inside the report)
            // — they can't navigate the preview away.
            guard navigationAction.targetFrame?.isMainFrame != false else {
                decisionHandler(.allow)
                return
            }
            let url = navigationAction.request.url
            if isInitialDocument(url) {
                decisionHandler(.allow)
                return
            }
            // A real link TAP to the outside opens in Safari; everything else
            // (JS redirects, meta refresh, form posts elsewhere) is dropped so
            // the preview never navigates away from the loaded file.
            if navigationAction.navigationType == .linkActivated,
               let url, url.scheme == "http" || url.scheme == "https" {
                Task { @MainActor in UIApplication.shared.open(url) }
            }
            decisionHandler(.cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            // Map server refusals onto the file browser's friendly copy instead
            // of rendering the raw plain-text error body as a page.
            if let http = navigationResponse.response as? HTTPURLResponse, http.statusCode >= 400 {
                let message: String
                switch http.statusCode {
                case 404: message = "File not found."
                case 403, 501: message = "File previews aren't available through the cloud companion — open this on your Mac."
                case 502: message = "Can't reach the file's host right now — try again when it reconnects."
                default: message = "The server couldn't serve this file (HTTP \(http.statusCode))."
                }
                Task { @MainActor in parent.phase = .failed(message) }
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            setPhase(.loaded)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            setPhase(.failed(error.localizedDescription))
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                     withError error: Error) {
            // Our own .cancel decisions surface here as "frame load
            // interrupted" — setPhase already refuses to clobber a friendly
            // failure; a genuine transport error still reports honestly.
            let nsError = error as NSError
            if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
            setPhase(.failed(error.localizedDescription))
        }
    }
}
