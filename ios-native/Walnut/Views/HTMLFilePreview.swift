import Observation
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
///
/// `Equatable` because the dock compares targets constantly: "is the presented
/// file the one being collapsed", "does the retained web view hold this file".
/// Comparing the derived `id` instead would work but hides the intent.
struct FilePreviewTarget: Identifiable, Equatable {
    let path: String
    /// nil/"" = the primary box; otherwise the session's exec-host alias.
    let host: String?
    var id: String { "\(host ?? "")\u{1}\(path)" }

    /// File name as shown in the dock bar and the sheet title.
    var displayName: String { (path as NSString).lastPathComponent }
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
///
/// `retained` picks which web view backs it, and the two modes are deliberately
/// different products:
///  - `false` (the default, and what the session file browser uses): a private
///    throwaway loader, created on appear and torn down on disappear. Byte for
///    byte the old behaviour: no seat is taken, no remembered position, and a
///    file opened there can never evict the report sitting in the dock.
///  - `true` (the timeline preview sheet): the ONE loader the `FilePreviewDock`
///    retains, so collapsing the sheet and coming back lands on the same pixel.
struct HTMLFilePreview: View {
    let path: String
    let host: String?
    var retained: Bool = false

    /// Optional: unit tests and the timeline harness build these views with no
    /// app environment, and `retained: false` needs no dock at all.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    /// Resolved in `onAppear`, never in `body`: adopting a loader mutates state
    /// (and, on the retained path, evicts a different file's renderer), and both
    /// must happen exactly once per appearance rather than on every body pass.
    @State private var loader: HTMLPreviewLoader?

    private var target: FilePreviewTarget { FilePreviewTarget(path: path, host: host) }

    var body: some View {
        ZStack {
            if WalnutAPI.rawFileContentURL(path: path, host: host) == nil {
                ContentUnavailableView {
                    Label("Not connected", systemImage: "wifi.slash")
                } description: {
                    Text("Pair with your Walnut server to preview files.")
                }
            } else if let loader {
                HTMLPreviewHostView(loader: loader)
                if loader.phase == .loading {
                    ProgressView()
                        .controlSize(.large)
                }
                if case .failed(let message) = loader.phase {
                    ContentUnavailableView {
                        Label("Can't preview file", systemImage: "doc.richtext")
                    } description: {
                        Text(message)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            } else {
                // One frame at most: `onAppear` runs right after this pass.
                ProgressView()
                    .controlSize(.large)
            }
        }
        .onAppear(perform: adopt)
        .onDisappear {
            // A throwaway loader is ours to kill, and a renderer process left
            // behind by a dismissed file browser is exactly the kind of memory
            // this app has been jetsam-killed for. The RETAINED one belongs to
            // the dock, which drops it on explicit close / a different file /
            // background / memory pressure, and never here.
            if !retained {
                loader?.teardown()
                loader = nil
            }
        }
        .accessibilityIdentifier("file.htmlPreview")
    }

    private func adopt() {
        guard loader == nil, let url = WalnutAPI.rawFileContentURL(path: path, host: host) else { return }
        if retained, let dock {
            loader = dock.loader(for: target, url: url, token: AppConfig.token)
        } else {
            loader = HTMLPreviewLoader(target: target, url: url, token: AppConfig.token)
        }
    }
}

/// Standalone sheet wrapper (timeline link taps, and the dock bar's reopen) —
/// same toolbar shape as the file viewer: share + Done.
///
/// This is also where the whole collapse contract lives, and it is deliberately
/// ONE path: `onAppear` claims the seat, `onDisappear` collapses into it. The
/// Done button only calls `dismiss()`. Recording the position in Done's action
/// would have been the obvious place and it would have been wrong: a swipe-down
/// dismissal never runs a button's action, so half of the dismissals (the common
/// half, on a phone) would have thrown the position away.
struct HTMLFilePreviewSheet: View {
    let target: FilePreviewTarget

    @Environment(\.dismiss) private var dismiss
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    init(target: FilePreviewTarget) {
        self.target = target
    }

    /// Path/host convenience for call sites that never held a target.
    init(path: String, host: String?) {
        self.target = FilePreviewTarget(path: path, host: host)
    }

    var body: some View {
        NavigationStack {
            HTMLFilePreview(path: target.path, host: target.host, retained: true)
                .navigationTitle(target.displayName)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        if let url = WalnutAPI.rawFileContentURL(path: target.path, host: target.host) {
                            ShareLink(item: url)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("file.preview.done")
                    }
                }
        }
        .onAppear { dock?.present(target) }
        .onDisappear { dock?.collapse(target) }
    }
}

/// The retained document: one `WKWebView`, its navigation lockdown, its load
/// phase, and the scroll position it should land on.
///
/// Lives OUTSIDE the view graph on purpose. A `UIViewRepresentable` cannot own
/// this, because a SwiftUI `.sheet` destroys its content view on dismiss and
/// runs `makeUIView` again on re-present: a view-owned web view is a NEW web
/// view every time, which is precisely why the preview used to reopen at the top
/// of the document. Here the web view outlives its container, and the container
/// (a plain `UIView` the representable does own) just re-parents it.
///
/// `@Observable` so `phase` drives the SwiftUI overlay. Everything else is
/// `@ObservationIgnored`: it is written from bind/teardown and from restore
/// arithmetic, and none of it should invalidate a view.
@Observable
@MainActor
final class HTMLPreviewLoader {
    let target: FilePreviewTarget
    let url: URL
    private(set) var phase: HTMLPreviewPhase = .loading

    /// The retained web view. `let` so nothing can swap it out from under a
    /// container that is currently hosting it.
    @ObservationIgnored let webView: WKWebView

    /// Strongly held: `WKWebView.navigationDelegate` is weak, so the navigator
    /// has to be owned by somebody, and the loader is the thing whose lifetime
    /// matches the web view's exactly.
    @ObservationIgnored private var navigator: HTMLPreviewNavigator?

    /// Scroll bookkeeping, in a reference box OUTSIDE the view graph and outside
    /// actor isolation.
    ///
    /// Same discipline `ScrollBottomTracking` uses, for the same reason: this is
    /// written from inside a scroll-geometry callback, where publishing anything
    /// re-invalidates the subtree being measured (the P0-2 non-convergent-layout
    /// freeze that left the chat timeline permanently blank). Nothing observes it.
    ///
    /// It is also why the box is a separate object rather than fields on the
    /// `@MainActor` loader. `UIScrollView` KVO is delivered on the main thread, but
    /// `MainActor.assumeIsolated` TRAPS if that assumption is ever wrong, and this
    /// callback fires on every scrolled frame — turning a wrong assumption into a
    /// field crash rather than a warning (the trade `BackgroundAssertion` documents
    /// and declines).
    ///
    /// `@unchecked Sendable` with the claim stated once, the same shape
    /// `CappedDownloadDelegate` uses: two independent `CGFloat`/`Bool` word-sized
    /// fields, written from the KVO callback and from the main actor, read only to
    /// decide a scroll position. There is no invariant spanning them, so a torn
    /// read is impossible and the worst case is one stale sample — a few pixels of
    /// scroll, not a corrupt state. A lock here would sit in a per-frame callback
    /// to protect nothing.
    private final class ScrollBank: @unchecked Sendable {
        /// Last good position seen on the live scroll view.
        ///
        /// Sampling continuously is NOT redundant with reading `contentOffset` at
        /// collapse time, and the difference is the bug it exists to prevent.
        /// `contentOffset` is clamped against the scroll view's bounds, and
        /// dismissing the sheet destroys the container the web view is parented
        /// into — so by the time anything asks "where was he", the answer can
        /// already have collapsed to 0, and banking that 0 erases the position
        /// instead of recording it. SwiftUI gives no ordering guarantee between an
        /// ancestor's `onDisappear` and the teardown of a descendant's
        /// `UIViewRepresentable`, so the capture cannot be TIMED.
        var offset: CGFloat = 0
        /// A restore is armed or in flight, so live samples are not yet the truth.
        var restorePending = false
    }

    @ObservationIgnored private let bank = ScrollBank()

    /// Offset to land on once the document is loaded and mounted, or nil.
    @ObservationIgnored private var pendingRestore: CGFloat? {
        didSet { bank.restorePending = pendingRestore != nil }
    }
    @ObservationIgnored private var restoreAttempts = 0

    /// Feeds `bank.offset`. One CGFloat write per callback, no publish. KVO on a
    /// scroll view is the established pattern here; `LetterHTMLBody` watches
    /// `contentSize` the same way.
    @ObservationIgnored private var offsetObservation: NSKeyValueObservation?

    /// Restores are attempted at most twice, ~400ms apart. Content that is still
    /// growing after that (a slow remote image, a chart drawn late by JS) loses
    /// the race, and losing it quietly is the right outcome: a scroll that jumps
    /// a second after the user started reading is worse than an approximate
    /// landing.
    private static let maxRestoreAttempts = 2
    private static let restoreRetryDelayMs = 400

    init(target: FilePreviewTarget, url: URL, token: String?) {
        self.target = target
        self.url = url
        let config = WKWebViewConfiguration()
        // Ephemeral store: nothing persisted, no cookie jar shared with the
        // app's URLSession or other previews. Remembering a scroll position
        // must NOT turn into remembering web content.
        config.websiteDataStore = .nonPersistent()
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        self.webView = webView
        let navigator = HTMLPreviewNavigator(url: url)
        self.navigator = navigator
        navigator.loader = self
        webView.navigationDelegate = navigator
        var request = URLRequest(url: url)
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        webView.load(request)
        observeOffset()
    }

    /// Keep the bank current. `.new` only (no `.initial`): the value the scroll
    /// view starts at is 0 and carries no information.
    private func observeOffset() {
        // `bank` (not `self`) is captured, so the callback touches no isolated
        // state and cannot resurrect a torn-down loader.
        let bank = self.bank
        offsetObservation = webView.scrollView.observe(
            \.contentOffset, options: [.new]
        ) { _, change in
            guard let y = change.newValue?.y else { return }
            // Ignore the rubber-band zone: a bounce past the top of a document
            // reports a negative offset, and a collapse landing mid-bounce would
            // bank it. (The table clamps too; this keeps the sample honest.)
            guard y >= 0 else { return }
            // Ignore everything until an outstanding restore has landed.
            // Re-parenting the web view clamps `contentOffset` to 0 against a
            // frame that is momentarily zero, which arrives here as a perfectly
            // ordinary sample and would erase the very position being put back.
            guard !bank.restorePending else { return }
            bank.offset = y
        }
    }

    /// Where the document is scrolled to, or nil when there is nothing worth
    /// recording. A preview that never loaded, or that failed, reports offset 0,
    /// and writing that into the table would silently forget a real position
    /// banked on a previous read of the same file.
    var capturedOffset: CGFloat? {
        guard case .loaded = phase else { return nil }
        return bank.offset
    }

    /// Mounted in a container right now. Load-bearing for `arm`: see below.
    var isBound: Bool { webView.superview != nil }

    /// Ask for a scroll position on the next mount. Arming nil is a no-op.
    ///
    /// Refused while the web view is BOUND, and that guard is the whole reason
    /// this is a method rather than a property. The dock re-arms the remembered
    /// offset from `loader(for:)`, which runs on every body pass of the preview;
    /// without the guard, a body pass that happens to coincide with a container
    /// rebuild while the user is reading would yank them back to wherever they
    /// were at the last collapse.
    func arm(_ offset: CGFloat?) {
        guard !isBound, let offset else { return }
        pendingRestore = offset
        restoreAttempts = 0
    }

    /// Adopt (or re-adopt) a container view. Idempotent, because
    /// `updateUIView` calls it on every SwiftUI update.
    func bind(into container: UIView) {
        guard webView.superview !== container else { return }
        webView.removeFromSuperview()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        // Next runloop, not now: re-parenting clamps `contentOffset` against a
        // frame that is still zero, so restoring inside this call would restore
        // to 0. (No-op while the document is still loading; `markLoaded` covers
        // that case.)
        Task { @MainActor [weak self] in self?.applyPendingRestore() }
    }

    /// The container is gone (sheet dismissed). Drops the view-hierarchy link so
    /// a dead container is not kept alive by the retained web view, and leaves
    /// the document itself loaded and scrolled where it was.
    func unbind() {
        webView.removeFromSuperview()
    }

    /// Give up the renderer. The dock keeps the seat and the remembered offset (it
    /// banks `capturedOffset` before calling this), so the next open re-creates a
    /// loader and restores approximately.
    ///
    /// Idempotent: the dock drops a loader for several independent reasons
    /// (explicit close, a different file, background, memory pressure) and a
    /// throwaway preview tears its own down on disappear.
    func teardown() {
        pendingRestore = nil
        offsetObservation?.invalidate()
        offsetObservation = nil
        webView.stopLoading()
        webView.navigationDelegate = nil
        navigator?.loader = nil
        navigator = nil
        webView.removeFromSuperview()
    }

    // MARK: - Navigation callbacks (hopped onto the main actor by the navigator)

    func markLoaded() {
        setPhase(.loaded)
        applyPendingRestore()
    }

    func setPhase(_ next: HTMLPreviewPhase) {
        // Never overwrite a friendly failure (set by the response check) with
        // the generic "cancelled" error our own .cancel produces. The response
        // check runs BEFORE the provisional-navigation failure it causes, so
        // "first failure wins" is exactly "the friendly one wins".
        if case .failed = phase { return }
        guard phase != next else { return }
        phase = next
    }

    /// Land on the remembered offset, honestly.
    ///
    /// Three things it refuses to do. It will not restore before the document has
    /// loaded (there is nothing to scroll yet, and `contentSize` is a lie). It will
    /// not scroll a document the user is already touching, because a restore that
    /// fights a live drag reads as the app wrestling the phone; it abandons the
    /// request instead, since the user has plainly taken over. And it clamps to the
    /// document's real scrollable height, so a report that got SHORTER since the
    /// last read lands at its bottom rather than somewhere impossible.
    ///
    /// If the document is still growing (a slow image, a chart JS draws late) the
    /// clamp lands short, and ONE retry is scheduled before the request is dropped.
    /// Dropping it is the deliberate choice: a page that jumps a second after the
    /// user has started reading is worse than an approximate landing.
    private func applyPendingRestore() {
        guard case .loaded = phase, let wanted = pendingRestore else { return }
        let scrollView = webView.scrollView
        guard !scrollView.isDragging, !scrollView.isDecelerating else {
            pendingRestore = nil
            return
        }
        let maxOffset = max(0, scrollView.contentSize.height - scrollView.bounds.height)
        let clamped = min(wanted, maxOffset)
        scrollView.setContentOffset(CGPoint(x: 0, y: clamped), animated: false)
        restoreAttempts += 1
        let shortOfTarget = clamped < wanted - 1
        if shortOfTarget, restoreAttempts < Self.maxRestoreAttempts {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .milliseconds(Self.restoreRetryDelayMs))
                self?.applyPendingRestore()
            }
            return
        }
        // Done trying. Seed the bank with where we actually landed BEFORE clearing
        // the flag, in that order: clearing it re-opens the sampler, and a sample
        // arriving in between would be the pre-restore position. Seeding also means
        // an immediate second collapse banks the truth rather than a stale target
        // the document could not reach.
        bank.offset = clamped
        pendingRestore = nil
    }
}

/// SwiftUI seam: a plain container the view graph may create and destroy at
/// will, into which the loader parents its long-lived web view.
private struct HTMLPreviewHostView: UIViewRepresentable {
    let loader: HTMLPreviewLoader

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .systemBackground
        loader.bind(into: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        // Re-present after a collapse hands the SAME loader a NEW container.
        loader.bind(into: container)
    }
}

/// Navigation lockdown + load reporting. Non-isolated on purpose (WebKit's
/// delegate methods are ObjC entry points): every touch of loader state hops
/// onto the main actor, and the only thing read synchronously here is the
/// immutable initial URL.
private final class HTMLPreviewNavigator: NSObject, WKNavigationDelegate {
    /// Weak: the loader owns this object.
    weak var loader: HTMLPreviewLoader?
    private let url: URL

    init(url: URL) {
        self.url = url
    }

    /// Initial document, ignoring fragment (in-page anchors must work).
    private func isInitialDocument(_ candidate: URL?) -> Bool {
        guard let candidate else { return false }
        var a = URLComponents(url: candidate, resolvingAgainstBaseURL: false)
        var b = URLComponents(url: url, resolvingAgainstBaseURL: false)
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
        let target = navigationAction.request.url
        if isInitialDocument(target) {
            decisionHandler(.allow)
            return
        }
        // A real link TAP to the outside opens in Safari; everything else
        // (JS redirects, meta refresh, form posts elsewhere) is dropped so
        // the preview never navigates away from the loaded file.
        if navigationAction.navigationType == .linkActivated,
           let target, target.scheme == "http" || target.scheme == "https" {
            Task { @MainActor in UIApplication.shared.open(target) }
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
            case 413: message = "This file is too large to preview on the phone — open it on your Mac."
            case 502, 503: message = "Can't reach the file's host right now — try again when it reconnects."
            default: message = "The server couldn't serve this file (HTTP \(http.statusCode))."
            }
            Task { @MainActor [loader] in loader?.setPhase(.failed(message)) }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [loader] in loader?.markLoaded() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor [loader] in loader?.setPhase(.failed(error.localizedDescription)) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        // Our own .cancel decisions surface here as "frame load interrupted"
        // — setPhase already refuses to clobber a friendly failure; a genuine
        // transport error still reports honestly.
        let nsError = error as NSError
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        let message = error.localizedDescription
        Task { @MainActor [loader] in loader?.setPhase(.failed(message)) }
    }
}
