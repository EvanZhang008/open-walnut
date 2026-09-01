import UIKit
import WebKit

/// One raw-HTML run of an assistant reply, rendered as a real web document
/// inside the UIKit timeline.
///
/// Why a dedicated cell rather than `UIHostingConfiguration` like the other
/// component rows: this cell owns a web view LIFECYCLE. A hosting
/// configuration rebuilds its content view on every reconfigure, which would
/// tear down and re-create the WKWebView on every streaming tick — a new web
/// process, a fresh document, and every bit of DOM state (an open `<details>`,
/// a checked CSS-only radio, the reader's text selection) gone.
///
/// Security posture, deliberately the LetterHTMLBody model rather than the
/// file-preview one, because a card is model-authored markup read blind:
/// scripts off for a content document, `baseURL: nil` so no relative reference
/// resolves anywhere, an ephemeral data store, and a navigation lockdown that
/// only ever renders the in-memory document. An island (```html-app) is the
/// explicit opt-in for code, and its document carries the CSP that keeps that
/// code off the network — the phone-side mirror of the web console's
/// `sandbox="allow-scripts"` iframe.
///
/// Height is the one number this cell owes the engine. Every other row kind is
/// measured on the layout actor; WebKit is main-thread-only, so here the cell
/// measures its own document and hands the number back through
/// `.richHeight`, and the coordinator rebuilds with it. See
/// `TimelineHost.Coordinator.handle` for why that loop settles.
final class TimelineRichHTMLCell: UICollectionViewCell {
    /// Two reuse pools over ONE class. `allowsContentJavaScript` is fixed when
    /// a web view is created, so a cell must never be handed the other kind's
    /// row — separate identifiers keep the pools apart by construction instead
    /// of by hope (there is a rebuild fallback below, but it should never run).
    static let contentReuseID = "richHTML"
    static let islandReuseID = "richIsland"

    /// A streaming card's html changes ~8x a second and `loadHTMLString`
    /// RE-CREATES the document every time (without JavaScript there is no
    /// incremental "replace the body"). Coalescing to ~3Hz is what makes a
    /// growing card readable instead of a strobe, and keeps the web content
    /// process off the CPU while the model talks.
    private static let streamingLoadInterval: CFTimeInterval = 0.3

    /// How many times ONE document may revise its own height, per load. A
    /// document sized in viewport units (`100vh`, `height: 100%`) measures
    /// whatever we just resized it to, so measure → resize → measure can
    /// alternate for ever between two honest answers — the 1pt dead band cannot
    /// see that, because both values are far apart.
    ///
    /// A HARD ceiling: only a new load resets it. The budget this replaces was
    /// cleared by `documentReportedHeight`, and EVERY observer message arrives on
    /// that path — so the one producer that can loop handed itself a fresh budget
    /// on every iteration and nothing was bounded at all. A body of
    /// `<div style="height:100vh"></div><div style="height:50px"></div>` climbed
    /// to the 4000pt clamp in ~80 rAF ticks that way, and a negative-slope one
    /// (`height: calc(600px - 100vh)`) never converged: a permanent ~30Hz
    /// relayout with an actor rebuild per iteration.
    ///
    /// Set high enough that reader-paced revisions never reach it — a reader
    /// opening and closing a `<details>` spends one per tap, an image finishing
    /// its decode one each — and, unlike a resettable budget, an island's own
    /// script cannot buy itself more by dispatching `toggle` events. Internal so
    /// the gate in `RichHTMLTimelineTests` names this number instead of copying it.
    static let maxHeightRevisionsPerLoad = 32

    /// Automatic re-loads after the web content process dies under this cell.
    /// Bounded because an island whose script kills the process would otherwise
    /// be re-mounted for ever; reuse (a different row, a different document) is
    /// what grants a fresh budget.
    private static let maxProcessRecoveries = 2

    /// Frame height a document is laid out at while it measures itself (see
    /// `layoutSubviews`). Small enough that the frame cannot floor the
    /// measurement, tall enough to be the row's own floor rather than a sliver,
    /// so a document that genuinely measures near zero doesn't flicker.
    private static let measureProbeHeight: CGFloat = TimelineMetrics.richMinHeight

    /// ONE ephemeral data store for every rich cell. WebKit gives each store
    /// its own web content process, so a store per cell meant a process per
    /// card — hundreds of MB on a transcript full of them, plus a launch stall
    /// per cell attach. Sharing leaks nothing: the store is non-persistent, and
    /// every document loads with `baseURL: nil`, so no two cards share an
    /// origin to leak through in the first place.
    private static let sharedDataStore = WKWebsiteDataStore.nonPersistent()

    private var webView: WKWebView?
    private var buildingLabel: UILabel?
    /// nil until the first configure creates a web view.
    private var loadedKind: RichHTMLDocument.Kind?
    /// The markup of the document currently up, kept so a light/dark flip can
    /// rebuild it with the other palette. The document text itself is not enough:
    /// the palette is baked THROUGH it, from the CSS variables to `color-scheme`.
    private var loadedBody: String?

    private weak var delegate: TimelineCellActionDelegate?
    private var rowID = ""
    private var documentKey = ""
    /// The width the row was BUILT at, passed in by the controller — not this
    /// cell's own bounds. The builder's height lookup keys on that number, so
    /// measuring against anything else would bank a height under a key nobody
    /// ever reads back.
    private var contentWidth: CGFloat = 0
    private var streaming = false

    /// Identity (document key + width + interface style) of what the web view
    /// is CURRENTLY showing, and of a throttled load that has not run yet.
    private var displayedIdentity: String?
    private var pendingIdentity: String?
    private var pendingDocument: String?
    private var throttleTimer: Timer?
    private var lastLoadAt: CFTimeInterval = 0

    #if DEBUG
    /// Document text last loaded, for the tests only (see the test hooks). Debug
    /// only because it is a full second copy of every document up — a few KB per
    /// live cell — and nothing in the shipping app ever reads it. The palette
    /// re-load needs `loadedBody`, not this.
    private var loadedDocument: String?
    #endif
    /// Row whose document the web view is CURRENTLY showing. Distinguishes "this
    /// row is reloading" (keep its pixels) from "this cell was recycled onto
    /// another row" (blank, never show the previous row's card here).
    private var displayedRowID: String?
    /// Still frame held over the web view while the next document loads.
    private var coverView: UIView?
    /// Relay for the document's own height reports (see `heightObserverScript`).
    /// A separate object because `addScriptMessageHandler` RETAINS its handler,
    /// and the cell owns the web view that owns the configuration — handing it
    /// `self` would be a cycle that keeps a web process alive per card.
    private var heightRelay: HeightRelay?
    /// Which of the two measurement paths produced the last number ("dom" or
    /// "scrollview"). Logged, because the difference matters: only the DOM answer
    /// can shrink a card, so a run where every line says `scrollview` means the
    /// isolated-world evaluation is being refused and the shrink bug is back.
    private var lastMeasureSource = "scrollview"

    private var reportedHeight: CGFloat = 0
    /// Height revisions this LOAD has already made (`maxHeightRevisionsPerLoad`).
    private var heightRevisions = 0
    /// Re-loads still available after a web content process death (see
    /// `webViewWebContentProcessDidTerminate`).
    private var processRecoveriesLeft = TimelineRichHTMLCell.maxProcessRecoveries
    /// A load THIS cell issued is waiting for its navigation to be decided.
    ///
    /// The navigation lockdown allows exactly that one and nothing else. It cannot
    /// be decided by URL: `loadHTMLString` has no URL of its own, and a
    /// `<meta http-equiv="refresh">` inside a card resolves against the document
    /// itself, so both arrive as the same `about:blank` (see `decidePolicyFor`).
    private var awaitingOwnNavigation = false
    /// Has the document currently loading FINISHED? Until it has, every
    /// `contentSize` change belongs either to the previous document still on
    /// screen (a reused cell shows it until the new load paints) or to a
    /// half-laid-out new one. Both measure something real and neither measures
    /// THIS card: five different documents each reported an identical bogus first
    /// height on a real transcript, and that junk both set wrong row heights and
    /// burned the revision budget the honest late measurements need.
    private var documentReady = false

    /// Which document a measurement belongs to.
    ///
    /// Read SYNCHRONOUSLY by both measurement paths — the moment `measureDocument`
    /// asks, and the moment the observer's message arrives — and carried across the
    /// hop to the report. WebKit runs both on the main thread, so at that instant
    /// the stamp still describes the document that measured itself. Read it on the
    /// far side of a hop instead and a measurement landing in the same run-loop turn
    /// as a cell REUSE is banked under the NEW row's key: a wrong height for a card
    /// the reader then sees clipped, healed only by the next re-measure.
    private final class LoadStamp {
        var rowID = ""
        var key = ""
        var width: CGFloat = 0
    }
    private let stamp = LoadStamp()
    /// An incomplete island's row revision changes on every tick (its html is
    /// growing), so `apply` runs at the full tick rate while the placeholder is
    /// up. This makes the second and later ticks free.
    private var placeholderShown = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        contentView.backgroundColor = .clear
        // The palette is baked into the document text, so a light/dark flip has
        // to re-load it — a dark-mode switch must not leave a white card
        // sitting in a dark transcript.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (cell: TimelineRichHTMLCell, _) in
            cell.reloadForInterfaceStyleChange()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        throttleTimer?.invalidate()
    }

    // MARK: - Configuration

    func configureContent(html: String, key: String, streaming: Bool, rowID: String,
                          contentWidth: CGFloat, delegate: TimelineCellActionDelegate?) {
        apply(html: html, key: key, kind: .content, streaming: streaming, complete: true,
              rowID: rowID, contentWidth: contentWidth, delegate: delegate)
    }

    func configureIsland(html: String, key: String, complete: Bool, rowID: String,
                         contentWidth: CGFloat, delegate: TimelineCellActionDelegate?) {
        // An island never streams: it is a placeholder until it is complete,
        // then it loads once. Nothing to coalesce.
        apply(html: html, key: key, kind: .island, streaming: false, complete: complete,
              rowID: rowID, contentWidth: contentWidth, delegate: delegate)
    }

    private func apply(html: String, key: String, kind: RichHTMLDocument.Kind,
                       streaming: Bool, complete: Bool, rowID: String,
                       contentWidth: CGFloat, delegate: TimelineCellActionDelegate?) {
        self.delegate = delegate
        self.rowID = rowID
        self.documentKey = key
        self.contentWidth = contentWidth
        self.streaming = streaming
        accessibilityIdentifier = Self.isIsland(kind) ? "chat.richIsland" : "chat.richHTML"

        // Is this cell holding some OTHER row's pixels? Read once, before
        // `showWebView` un-hides anything, because BOTH of the exits below can be
        // reached by a recycle and each has to blank in its own way.
        let recycled = displayedRowID != nil && displayedRowID != rowID
        guard complete else {
            // The placeholder path used to return from here BEFORE any blanking,
            // and `removeCover` only ever ran in `didFinish` — which never comes
            // for an island that is still arriving. A cell recycled mid-reload
            // therefore kept a snapshot of ANOTHER message's card painted on top
            // of "Building interactive block…", for good. `showBuildingPlaceholder`
            // now drops the still frame with the same call that hides the web view.
            showBuildingPlaceholder()
            return
        }
        showWebView(kind: kind)
        let style = traitCollection.userInterfaceStyle
        let identity = Self.identity(key: key, width: contentWidth, style: style)
        // IDEMPOTENT, and load-bearing: configure runs on every cell attach AND
        // on every streaming reload tick. Re-loading an unchanged document
        // restarts it — scroll position, text selection and any open
        // `<details>` are lost, and a reader watching a card build would see it
        // blink several times a second for no new content.
        guard identity != displayedIdentity, identity != pendingIdentity else {
            // Not necessarily the same ROW, though: two rows of a streaming reply
            // routinely carry a byte-identical card (the same card repeated), so a
            // RECYCLE lands here too. The load's bookkeeping has to follow the row
            // anyway or every later height report is banked under the row this cell
            // came FROM — a wrong height for a card the reader then sees clipped —
            // and `performLoad`'s `displayedRowID == rowID` check misses, so the
            // next reload blanks instead of holding a still frame.
            stampCurrentRow()
            if identity == displayedIdentity, documentReady {
                // The pixels up ARE this row's document, byte for byte, so claim
                // them: nothing to blank, and this row's own next reload gets its
                // still frame. `documentReady` is the difference between "that
                // document is on screen" and "that document is on its way" — while
                // it loads, what the reader can see is still the previous one.
                displayedRowID = rowID
            } else if recycled {
                // The matching document is only PENDING (a throttled load, or one
                // still in flight), so what is on screen belongs to the other row and
                // must not be seen in this one. `didFinish` unhides it.
                webView?.isHidden = true
                removeCover()
            }
            return
        }
        // A recycled cell is still showing the card of the row it came from. That
        // card must not be visible for one more frame in THIS row — a reader saw
        // one reply's "Conclusion" card painted into another reply's streaming
        // tail. Blank until the new document paints; the same row's own reload
        // keeps its pixels instead (coverDuringLoad).
        if recycled {
            webView?.isHidden = true
            removeCover()
        }
        loadedBody = html
        let document = RichHTMLDocument.page(
            body: html, palette: Self.palette(for: style), kind: kind
        )
        scheduleLoad(document, identity: identity)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        // A throttled load belongs to the row this cell is LEAVING; letting it
        // fire would paint another row's card here.
        cancelPendingLoad()
        placeholderShown = false
        // The still frame exists to bridge ONE row's own reload, and reuse means
        // that row is gone. Only `didFinish` used to remove it, so a cell recycled
        // mid-reload onto a row that never finishes (an incomplete island, a failed
        // load) showed the previous message's card for the rest of its life. Worst
        // case of dropping it here is a same-row re-attach seeing an empty box for
        // a few tens of milliseconds; showing the WRONG message's card is not a
        // trade against that.
        removeCover()
        // A different row means a different document, so the crash budget starts
        // over. Reuse needs the reader to scroll, so this cannot become a loop.
        processRecoveriesLeft = Self.maxProcessRecoveries
        // Scrolling belongs to the DOCUMENT (`report` decides it from the measured
        // height), so a card that earned its own scroller must not hand it — nor
        // its two VoiceOver elements — to the next, shorter row this cell serves.
        // Reuse is the only safe place to reset it: doing the same in `performLoad`
        // would flip it off and on again every 300ms under a stream, cancelling the
        // drag of a reader scrolling inside a tall card.
        if let scrollView = webView?.scrollView { Self.setScrolling(false, on: scrollView) }
        // `displayedIdentity` deliberately survives: it describes what the web
        // view still holds, which is what makes re-attaching the same row a
        // no-op rather than a reload.
        delegate = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let box = contentView.bounds.inset(by: UIEdgeInsets(
            top: TimelineMetrics.richVMargin, left: TimelineMetrics.hMargin,
            bottom: TimelineMetrics.richVMargin, right: TimelineMetrics.hMargin
        ))
        buildingLabel?.frame = box
        // The document gets its OWN height, never the row's.
        //
        // A WKWebView's `scrollView.contentSize` can never be SHORTER than the
        // web view's frame, so a card laid out at the row's height MEASURES
        // WHATEVER THE ROW ALREADY GUESSED: an over-estimate confirms itself and
        // the card sits for ever in a box several times its size. That is not
        // hypothetical — it is what a real transcript looked like, a 60pt
        // comparison card in a 466pt row, because the first-guess heuristic
        // counted a harvested `<style>` block as prose.
        //
        // So: a small probe height until the document has measured itself, its
        // own measurement afterwards. A document sized in viewport units
        // (`100vh`) is the one that loses here — it measures the probe — and
        // that is the right way round for a chat card, where flowing prose and
        // panels are the whole population.
        applyDocumentFrame(in: box)
        coverView?.frame = webView?.frame ?? box
    }

    /// The web view's frame for the current knowledge about its document.
    ///
    /// Called from `layoutSubviews` AND synchronously from `performLoad`, and the
    /// second call site is the load-bearing one: `didFinish` reports the moment a
    /// document lands, so if the frame were still the PREVIOUS document's height
    /// at that instant, the new document would be floored at it and adopt another
    /// card's height. That is exactly what a hostile read of the field evidence
    /// showed — every wrong height was some other card's height, never a random
    /// number.
    private func applyDocumentFrame(in box: CGRect? = nil) {
        guard let webView else { return }
        let box = box ?? contentView.bounds.inset(by: UIEdgeInsets(
            top: TimelineMetrics.richVMargin, left: TimelineMetrics.hMargin,
            bottom: TimelineMetrics.richVMargin, right: TimelineMetrics.hMargin
        ))
        var frame = box
        frame.size.height = reportedHeight > 0
            ? reportedHeight
            : min(box.height, Self.measureProbeHeight)
        webView.frame = frame
    }

    // MARK: - Loading

    private func scheduleLoad(_ document: String, identity: String) {
        let now = CACurrentMediaTime()
        let earliest = lastLoadAt + Self.streamingLoadInterval
        guard streaming, now < earliest else {
            performLoad(document, identity: identity)
            return
        }
        // Trailing timer, latest content wins: whatever tick lands last before
        // it fires is what the reader sees, so no intermediate state is ever
        // rendered and a fast stream costs exactly one load per interval.
        pendingIdentity = identity
        pendingDocument = document
        guard throttleTimer == nil else { return }
        let timer = Timer(timeInterval: earliest - now, repeats: false) { [weak self] _ in
            self?.flushPendingLoad()
        }
        // `.common`, not the default mode: a card streaming while the reader
        // scrolls would otherwise stall until the finger lifted, because the
        // main run loop is in tracking mode for the whole gesture.
        RunLoop.main.add(timer, forMode: .common)
        throttleTimer = timer
    }

    private func flushPendingLoad() {
        throttleTimer = nil
        guard let document = pendingDocument, let identity = pendingIdentity else { return }
        pendingDocument = nil
        pendingIdentity = nil
        performLoad(document, identity: identity)
    }

    private func cancelPendingLoad() {
        throttleTimer?.invalidate()
        throttleTimer = nil
        pendingDocument = nil
        pendingIdentity = nil
    }

    private func performLoad(_ document: String, identity: String) {
        // Freeze what the reader is looking at BEFORE the teardown (only the same
        // row's own pixels — `apply` blanks a recycled cell instead).
        if displayedRowID == rowID { coverDuringLoad() }
        displayedIdentity = identity
        #if DEBUG
        loadedDocument = document
        #endif
        lastLoadAt = CACurrentMediaTime()
        // A different document may measure taller or shorter, so its height
        // budget starts over with it — and nothing it says counts until it has
        // finished loading.
        //
        // The exception is a document THIS width has already measured: scrolling
        // a card off screen and back re-loads it, and starting that from the
        // probe height would show a 40pt sliver inside a correctly sized row for
        // a frame or two. A banked height came from an honest probe measurement,
        // so laying out at it cannot floor anything new — and the confirming
        // report lands inside the dead band, costing no rebuild.
        //
        // A STREAMING card is the second exception, and for a sharper reason: its
        // document key changes on every tick, so the exact table always misses
        // mid-stream. Falling to the probe there would collapse the card to a
        // sliver and grow it back several times a second — the strobe the load
        // throttle exists to prevent. Its own last height is the right starting
        // point; the growing document reports past it, and the settled document
        // (a new key, `streaming` false) goes back through the probe, so a card
        // that briefly withheld an unfinished tag can still shrink to its
        // finished size.
        reportedHeight = RichHTMLHeightCache.shared.height(key: documentKey, width: contentWidth)
            ?? (streaming ? (RichHTMLHeightCache.shared.lastHeight(rowID: rowID) ?? 0) : 0)
        heightRevisions = 0
        documentReady = false
        stampCurrentRow()
        // Frame FIRST, document second: see applyDocumentFrame.
        applyDocumentFrame()
        // The ONE navigation the lockdown will allow is the one this line starts.
        awaitingOwnNavigation = true
        webView?.loadHTMLString(document, baseURL: nil)
    }

    /// Point the load stamp at the row this cell now serves.
    ///
    /// Called from `performLoad` and from the identity early return, and the second
    /// call site is why it exists: a recycle that changes nothing but the row id
    /// still has to move the stamp, or the document's own height reports are banked
    /// under the row the cell came from.
    private func stampCurrentRow() {
        stamp.rowID = rowID
        stamp.key = documentKey
        stamp.width = contentWidth
    }

    /// Hold the card's current pixels still while the next document loads.
    ///
    /// `loadHTMLString` tears the document down and builds a new one, so a card
    /// under a stream (a reload every 300ms) spent about half its life as an EMPTY
    /// box, and sometimes as a half-painted one. A snapshot of what the reader was
    /// already looking at, removed the moment the new document paints, turns that
    /// into a still frame — the pixels are stale for a few tens of milliseconds,
    /// which is exactly what a video player does between frames.
    ///
    /// Only ever the SAME row's own pixels: a recycled cell holds another
    /// message's card, and freezing that would paint one reply's card into
    /// another's row. That case hides the web view instead (see `apply`).
    private func coverDuringLoad() {
        guard coverView == nil, let webView, !webView.isHidden,
              webView.bounds.height > 1, displayedIdentity != nil,
              let snapshot = webView.snapshotView(afterScreenUpdates: false) else { return }
        snapshot.frame = webView.frame
        snapshot.isUserInteractionEnabled = false
        contentView.addSubview(snapshot)
        coverView = snapshot
    }

    private func removeCover() {
        coverView?.removeFromSuperview()
        coverView = nil
    }

    /// Light/dark flipped: the palette is baked into the document, so the only
    /// fix is a re-load — and this cell has to run it ITSELF. Dropping the
    /// identity only makes the NEXT configure see a change, and a trait flip
    /// reconfigures nothing: the rows are unchanged, so the collection view has
    /// no reason to touch this cell. Left at that, a card kept its light palette
    /// in a black transcript (dark-grey SVG labels, dark-grey prose) until the
    /// row happened to rebuild for some other reason.
    private func reloadForInterfaceStyleChange() {
        displayedIdentity = nil
        cancelPendingLoad()
        // Nothing to re-palette while the building placeholder is up, and re-loading
        // there is actively wrong: `loadedBody` is the last COMPLETE document this
        // cell held, so this would mount another row's card into a hidden web view,
        // unhide it at `didFinish` (leaving the label on top of it) and bank that
        // document's height under THIS island's key. The label's own colour is a
        // dynamic one and needs no reload; dropping the identity above is enough to
        // make the island load with the new palette once it arrives.
        guard !placeholderShown else { return }
        guard let body = loadedBody, let kind = loadedKind, webView != nil else { return }
        let style = traitCollection.userInterfaceStyle
        let document = RichHTMLDocument.page(
            body: body, palette: Self.palette(for: style), kind: kind
        )
        // Straight to the load: a scheme flip is a one-off, so the streaming
        // throttle has nothing to protect here.
        performLoad(document,
                    identity: Self.identity(key: documentKey, width: contentWidth, style: style))
    }

    // MARK: - Subviews

    private func showWebView(kind: RichHTMLDocument.Kind) {
        buildingLabel?.isHidden = true
        placeholderShown = false
        if let webView, let loadedKind, Self.isIsland(loadedKind) == Self.isIsland(kind) {
            webView.isHidden = false
            return
        }
        if webView != nil {
            // Unreachable: reuse pools are per-kind. Rebuilding rather than
            // reusing matters anyway — serving an island through the
            // script-less configuration would silently break it, and the
            // reverse would run a card's markup with scripting on.
            webView?.removeFromSuperview()
        }
        let created = makeWebView(kind: kind)
        installHeightObserver(on: created)
        contentView.addSubview(created)
        webView = created
        loadedKind = kind
        displayedIdentity = nil
        setNeedsLayout()
    }

    private func makeWebView(kind: RichHTMLDocument.Kind) -> WKWebView {
        let webView = WKWebView(frame: contentView.bounds,
                                configuration: Self.configuration(for: kind))
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        // The transcript owns scrolling; a nested scroller would fight it. Only
        // a document that overflows the height clamp gets its own back — see
        // `setScrolling`, which owns that state and everything derived from it.
        Self.setScrolling(false, on: webView.scrollView)
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        return webView
    }

    /// Whether this card scrolls itself, and the two VoiceOver elements that ride
    /// along with a scroll view's indicators.
    ///
    /// A `UIScrollView` publishes each indicator to VoiceOver as an element of its
    /// own ("Vertical scroll bar, 1 page"), and it does so whether or not the view
    /// can actually scroll. Every rich card therefore cost a reader two swipes past
    /// meaningless controls before reaching the card's own prose, on every card in
    /// a transcript. Suppressing the indicators is the fix because the indicator IS
    /// the element; `accessibilityElementsHidden` on the scroll view is the wrong
    /// tool and would take the card's content with it, since WebKit hangs the
    /// document's whole accessibility tree off a content view INSIDE this scroll
    /// view.
    ///
    /// The VERTICAL one comes back for the one card that keeps its own scrolling:
    /// past `richMaxHeight` `report` hands it back, and a scroller the reader has to
    /// use to reach clipped content is one VoiceOver must still be able to find. The
    /// horizontal one stays off either way — a card is laid out at the row's width,
    /// so it never scrolls sideways, and enabling both axes together published a
    /// junk "Horizontal scroll bar, 1 page" next to the tall card's legitimate
    /// vertical one. (A `<pre>` that overflows scrolls inside the DOCUMENT, which is
    /// its own scroller and unaffected by this.)
    private static func setScrolling(_ enabled: Bool, on scrollView: UIScrollView) {
        scrollView.isScrollEnabled = enabled
        scrollView.showsVerticalScrollIndicator = enabled
        scrollView.showsHorizontalScrollIndicator = false
    }

    /// Injects the document-side height observer and its return channel, both in
    /// the isolated world. Done here rather than in `configuration(for:)` because
    /// the handler is per-cell and must be weak (see `HeightRelay`).
    private func installHeightObserver(on webView: WKWebView) {
        let controller = webView.configuration.userContentController
        let relay = HeightRelay()
        relay.cell = self
        heightRelay = relay
        controller.removeScriptMessageHandler(forName: Self.heightChannel,
                                              contentWorld: .defaultClient)
        controller.add(relay, contentWorld: .defaultClient, name: Self.heightChannel)
        controller.addUserScript(WKUserScript(source: Self.heightObserverScript,
                                              injectionTime: .atDocumentEnd,
                                              forMainFrameOnly: true,
                                              in: .defaultClient))
    }

    private static let heightChannel = "walnutRichHeight"

    private static func configuration(for kind: RichHTMLDocument.Kind) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = sharedDataStore
        // A content card is a DOCUMENT: nothing in styled markup needs to run
        // code. Nothing is stripped from the markup on the way in — this flag
        // plus the wrapper's script-less CSP is what makes a `<script>` in a
        // card inert. An island asked for scripting explicitly, and its own CSP
        // is what keeps that code off the network.
        config.defaultWebpagePreferences.allowsContentJavaScript = isIsland(kind)
        // A `<video>` in a card must play where it sits: this defaults to false
        // on iOS, which hands playback to the fullscreen player — and with
        // scripting off nothing in the document can ask for fullscreen, so the
        // clip would just do nothing when tapped (the letter reader hit exactly
        // this).
        config.allowsInlineMediaPlayback = true
        // Still requires a human tap, so no card starts making noise when it
        // scrolls into view.
        config.mediaTypesRequiringUserActionForPlayback = .all
        return config
    }

    /// Placeholder for an island that is still arriving. A LABEL, not a hidden
    /// web view: mounting a half-written island would run half a script.
    private func showBuildingPlaceholder() {
        guard !placeholderShown else { return }
        placeholderShown = true
        cancelPendingLoad()
        webView?.isHidden = true
        // "Placeholder up" and "still frame up" are mutually exclusive states: the
        // frame is a snapshot of a document that is not this row's, and the only
        // thing that used to remove it was a `didFinish` this row will never get.
        removeCover()
        if buildingLabel == nil {
            let label = UILabel()
            label.font = TimelineTextStyler.captionFont
            label.textColor = .secondaryLabel
            label.text = "⚙︎ Building interactive block…"
            contentView.addSubview(label)
            buildingLabel = label
        }
        buildingLabel?.isHidden = false
        setNeedsLayout()
    }

    // MARK: - Height measurement

    // A `scrollView.contentSize` observation used to live here, and removing it is
    // the fix for a card that grew back after the reader collapsed it. That value
    // is FLOORED by the web view's own frame, so it can only ever push a card
    // taller: the DOM said 42, the observation immediately answered 109 (the frame
    // it still had), and 109 is what stuck. Everything it was there for — a
    // data-URI image finishing its decode, a font swapping in — the document's own
    // ResizeObserver reports, unfloored. `measureDocument` keeps the scroll view
    // as a FALLBACK for the one case that would otherwise go unmeasured: the
    // isolated-world evaluation being refused outright.

    /// Ask the DOCUMENT how tall it is, rather than asking the scroll view.
    ///
    /// `document.documentElement.scrollHeight` is the real answer and the only one
    /// that can SHRINK: a `<details>` the reader collapses leaves `contentSize`
    /// pinned at the frame it already had, so the card kept 83pt of dead space for
    /// the rest of the session. This evaluates in an ISOLATED content world, which
    /// is host-side script execution — `allowsContentJavaScript` stays off, so the
    /// model's own markup still cannot run a line of code. If the evaluation fails
    /// for any reason, the scroll view's (floored) number is still there as the
    /// fallback, so a card is never left unmeasured.
    private func measureDocument() {
        guard let webView, documentReady else { return }
        let (rowID, key, width) = (stamp.rowID, stamp.key, stamp.width)
        webView.evaluateJavaScript(
            // Body box, not `documentElement.scrollHeight` — see the observer
            // script for why that one is floored by the frame.
            """
            (function () {
              var b = document.body;
              if (!b) return 0;
              return Math.ceil(Math.max(b.getBoundingClientRect().height, b.scrollHeight));
            })()
            """, in: nil, in: .defaultClient
        ) { [weak self, weak webView] result in
            // `webView` weakly too, not just `self`: a strong capture here keeps the
            // web view — and its share of a web content process — alive for as long
            // as WebKit holds the completion block, which for a document whose
            // process is wedged or already gone is for ever. The cell it belonged to
            // is meanwhile long recycled.
            Task { @MainActor in
                guard let self, let webView else { return }
                let height: CGFloat
                if case .success(let value) = result,
                   let number = value as? NSNumber, number.doubleValue > 0 {
                    height = CGFloat(number.doubleValue)
                    self.lastMeasureSource = "dom"
                } else {
                    height = webView.scrollView.contentSize.height
                    self.lastMeasureSource = "scrollview"
                }
                self.report(contentHeight: height, rowID: rowID, key: key, width: width)
            }
        }
    }

    /// The document says it re-laid itself out at `height`.
    ///
    /// This is what makes a card able to SHRINK. A `<details>` the reader collapses
    /// changes no document key, so nothing reloads and nothing re-probes; the
    /// scroll view stays pinned at the frame it already had, and the card kept 83pt
    /// of dead space for the rest of the session. The document is the only party
    /// that knows, so it tells us.
    ///
    /// Deliberately NO budget reset here. A layout the READER caused is not the
    /// machine oscillation the ceiling exists to stop, and this path used to clear
    /// the count for exactly that reason — open and close a disclosure four times
    /// and all four must land. But EVERY observer message arrives here, the
    /// machine's included, so the reset was handed to the one producer that can
    /// loop and the ceiling bounded nothing. `maxHeightRevisionsPerLoad` is high
    /// enough to cover reader-paced revisions instead, and cannot be topped up by
    /// an island script dispatching its own `toggle` events.
    private func documentReportedHeight(_ height: CGFloat, rowID: String, key: String,
                                        width: CGFloat) {
        report(contentHeight: height, rowID: rowID, key: key, width: width)
    }

    /// Installed in the ISOLATED world at document end, so it observes the page
    /// without the page being able to see it — and for a content card the page has
    /// no scripting at all. `toggle` covers `<details>`; the transition/animation
    /// events cover a CSS-only stepper and an animated card; `ResizeObserver`
    /// covers everything else (an image finishing its decode, a font swapping, an
    /// island rewriting its own DOM).
    private static let heightObserverScript = """
    (function () {
      var last = -1;
      function measure() {
        // The BODY's own box, never `documentElement.scrollHeight`: that one is
        // floored by the viewport (which is the web view's frame), so it reports
        // the height we already set and a collapsing `<details>` looks unchanged.
        // `scrollHeight` joins it for content that overflows the body box.
        var b = document.body;
        if (!b) return 0;
        var rect = b.getBoundingClientRect().height;
        return Math.ceil(Math.max(rect, b.scrollHeight));
      }
      var pending = false;
      function post() {
        // Two frames, then measure: a `toggle`/`transitionend` listener can run
        // BEFORE the layout it is reacting to, and a stale read here is a wrong
        // row height that nothing corrects.
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            pending = false;
            var h = measure();
            if (h === last || h <= 0) return;
            last = h;
            window.webkit.messageHandlers.walnutRichHeight.postMessage(h);
          });
        });
      }
      try { new ResizeObserver(post).observe(document.body); } catch (e) {}
      document.addEventListener('toggle', post, true);
      document.addEventListener('transitionend', post, true);
      document.addEventListener('animationend', post, true);
      window.addEventListener('load', post);
      post();
    })();
    """

    /// Weak bridge from the injected script back to the cell (see `heightRelay`).
    private final class HeightRelay: NSObject, WKScriptMessageHandler {
        weak var cell: TimelineRichHTMLCell?
        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard let cell, let height = (message.body as? NSNumber)?.doubleValue,
                  height > 0 else { return }
            // Which document measured itself is read HERE, in the run-loop turn
            // WebKit delivered the message (the handler protocol is `@MainActor`,
            // so this already runs on the main thread — no hop needed, and none
            // wanted). The version that went through `Task { @MainActor }` first
            // read the stamp on the far side of the hop, so a report landing in the
            // same turn as a cell REUSE was banked under the new row's key.
            // `measureDocument` captures it synchronously for the same reason.
            cell.lastMeasureSource = "observer"
            cell.documentReportedHeight(CGFloat(height), rowID: cell.stamp.rowID,
                                        key: cell.stamp.key, width: cell.stamp.width)
        }
    }

    /// Bank a measurement with the coordinator.
    ///
    /// The 1pt dead band is not a nicety: assigning the reported height resizes
    /// the web view, which lays out again and fires `contentSize` — without the
    /// band this is a render loop rather than a measurement (LetterHTMLBody has
    /// the same one for the same reason).
    ///
    /// `ignoringReadiness` is for the one measurement that can never wait for a
    /// document to finish: the fallback height of a load that FAILED (see
    /// `reportMinimumHeight`). Nothing else may skip that gate.
    private func report(contentHeight: CGFloat, rowID: String, key: String, width: CGFloat,
                        ignoringReadiness: Bool = false) {
        guard documentReady || ignoringReadiness else { return }
        guard contentHeight > 0, width > 0, !key.isEmpty else { return }
        let measured = ceil(contentHeight)
        let height = min(max(measured, TimelineMetrics.richMinHeight),
                         TimelineMetrics.richMaxHeight)
        // Past the clamp the card cannot show everything it has, so it gets its
        // own vertical scrolling back: clipped-and-unreachable is the one
        // outcome worse than a nested scroller. Decided BEFORE the revision
        // ceiling, because a document frozen at the ceiling is precisely the one
        // whose content the reader may otherwise have no way to reach.
        if let scrollView = webView?.scrollView {
            Self.setScrolling(measured > TimelineMetrics.richMaxHeight, on: scrollView)
        }
        guard heightRevisions < Self.maxHeightRevisionsPerLoad else {
            // Said once per load, not at rAF pace: the count runs one PAST the
            // ceiling so a document stuck in measure → resize → measure leaves
            // exactly one line behind instead of thirty a second.
            if heightRevisions == Self.maxHeightRevisionsPerLoad {
                heightRevisions += 1
                AppLog.debug("richhtml", "height ceiling", ["rowID": rowID, "key": key,
                                                           "raw": String(Int(contentHeight)),
                                                           "held": String(Int(reportedHeight))])
            }
            return
        }
        guard abs(height - reportedHeight) > 1 else { return }
        reportedHeight = height
        heightRevisions += 1
        // One line per document per load once the gate above is honoured, and the
        // only window into this loop from a running app: a wrong row height is
        // invisible in a screenshot but obvious here (a document that reports
        // twice, or reports a height it cannot have).
        AppLog.debug("richhtml", "measured", ["rowID": rowID, "key": key,
                                             "raw": String(Int(contentHeight)),
                                             "height": String(Int(height)),
                                             "frame": String(Int(webView?.frame.height ?? -1)),
                                             "via": lastMeasureSource])
        // Grow to the measured height NOW rather than waiting for the rebuild to
        // come back around: the row is still the size of a guess, and the
        // document is the one thing here that knows better.
        setNeedsLayout()
        delegate?.timelineCell(didRequest: .richHeight(
            rowID: rowID, key: key, width: width, height: height
        ))
    }

    // MARK: - Test hooks

    // DEBUG only. These are a real surface — a whole extra copy of every document
    // (`loadedDocument`), and five entry points that write state WebKit is supposed
    // to own — and none of it belongs in a shipping build. The gates that use them
    // live in `RichHTMLTimelineTests`, which only ever builds Debug.
    #if DEBUG
    /// The web view under test, so a case can assert the frame the document is
    /// laid out at (the height-floor invariant) without loading anything.
    var webViewForTesting: WKWebView? { webView }

    /// The document text last handed to WebKit. A test cannot read it back out of
    /// the web view (that would need JavaScript, which a card does not have), so
    /// the palette a flip re-loaded with is only assertable from here.
    var loadedDocumentForTesting: String? { loadedDocument }

    /// The still frame held over the web view, and a way to put a stand-in one up.
    ///
    /// Settable because `snapshotView(afterScreenUpdates:)` on a cell that was
    /// never rendered can legitimately return nil, so a case about the cover being
    /// DROPPED installs one rather than hoping a real snapshot appears — and it has
    /// to be a real subview, or "nothing of the old row is visible" proves nothing.
    var coverForTesting: UIView? {
        get { coverView }
        set {
            removeCover()
            guard let newValue else { return }
            newValue.frame = webView?.frame ?? contentView.bounds
            contentView.addSubview(newValue)
            coverView = newValue
        }
    }

    /// Stand in for a measurement WebKit would deliver, so the "document owns its
    /// own height" half of that invariant is testable without a real load.
    func applyMeasuredHeightForTesting(_ height: CGFloat) {
        reportedHeight = height
        setNeedsLayout()
    }

    /// Feed a height through the SAME path the document's own observer uses, so a
    /// case can check what the cell does with a measurement taken before the
    /// document finished loading (throw it away), and cannot accidentally pass the
    /// revision ceiling by entering below the path that used to reset it.
    func observeContentHeightForTesting(_ height: CGFloat) {
        documentReportedHeight(height, rowID: stamp.rowID, key: stamp.key, width: stamp.width)
    }

    /// The `didFinish` half of that, without a real navigation: the document is
    /// ready AND the row it belongs to is the one the web view is showing — the
    /// second half is what the recycle blanking keys on.
    func markDocumentReadyForTesting() {
        documentReady = true
        displayedRowID = stamp.rowID
    }
    #endif

    // MARK: - Helpers

    /// `Kind` belongs to the document builder; compared through a switch so
    /// this file never depends on it declaring `Equatable`.
    private static func isIsland(_ kind: RichHTMLDocument.Kind) -> Bool {
        switch kind {
        case .island: return true
        case .content: return false
        }
    }

    private static func palette(for style: UIUserInterfaceStyle) -> RichHTMLPalette {
        style == .dark ? .dark : .light
    }

    private static func identity(key: String, width: CGFloat,
                                 style: UIUserInterfaceStyle) -> String {
        // Width at whole-point resolution, matching the height cache's own
        // quantisation: sub-pixel jitter must not count as a content change.
        "\(key)|\(Int(width.rounded()))|\(style.rawValue)"
    }
}

// MARK: - Navigation lockdown

extension TimelineRichHTMLCell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentReady = true
        // Normally already consumed by the policy decision; cleared again for the
        // load that never reached it at all (no web view yet), so an allowance can
        // never sit around waiting for a navigation this cell did not ask for.
        awaitingOwnNavigation = false
        displayedRowID = stamp.rowID
        // The new document is painted, so the still frame (or the blank, on a
        // recycled cell) has done its job.
        //
        // Only for a document this cell still SERVES, though: a load issued for the
        // row the cell came from can finish AFTER a recycle (nothing cancels an
        // in-flight WebKit load), and revealing it then paints one message's card
        // into another's row — under a "Building interactive block…" label, when the
        // row it landed on is an island that has not arrived. The stamp and the
        // current row are equal for every load this cell issued, so this only ever
        // withholds a document whose row has moved on; that row's own load unhides it.
        if !placeholderShown, stamp.rowID == rowID { webView.isHidden = false }
        removeCover()
        // Ask the document, not the scroll view: the scroll view cannot report a
        // height below the frame, which is how a card used to get stuck too tall.
        measureDocument()
        // One late look, for the case where the injected observer never installed
        // (an old WebKit without ResizeObserver): a data-URI image finishing its
        // decode is the growth this would otherwise miss.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            self?.measureDocument()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // Sub-frames can't navigate the transcript away; let them settle.
        guard navigationAction.targetFrame?.isMainFrame != false else {
            decisionHandler(.allow)
            return
        }
        let url = navigationAction.request.url
        // The in-memory document THIS cell just handed to WebKit, and only that
        // one. Decided by STATE, never by URL: `loadHTMLString` has no URL of its
        // own, and a `<meta http-equiv="refresh" content="0">` inside a card
        // resolves against the document itself, so both arrive as the same
        // `about:blank`. The scheme test that used to stand here therefore allowed
        // the refresh as readily as the load — a card could blank itself and
        // re-navigate in a loop, each cycle spending a didFinish, a measurement and
        // a 0.4s timer in the web content process EVERY other card shares.
        //
        // Unlike LetterHTMLBody nothing here allows `file:`; that path exists there
        // only because a streamed letter body is loaded from disk.
        if awaitingOwnNavigation, navigationAction.navigationType != .linkActivated {
            // Consumed by the decision, not by `didFinish`: a finish for a load this
            // cell has already superseded can be delivered AFTER the next
            // `loadHTMLString`, and clearing on that would cancel the new load and
            // leave the card blank until something else reconfigured it.
            awaitingOwnNavigation = false
            decisionHandler(.allow)
            return
        }
        // Second gate, and the reason a mistake in the first one cannot black out a
        // card: a document load can only ever arrive while this cell has NO finished
        // document (`performLoad` clears `documentReady` immediately before issuing
        // it). A card's self-navigation is the opposite case — a scheduled refresh
        // runs once the document HAS finished — so it cannot come through here, and
        // an island reloading itself from document-start gets one cycle before its own
        // didFinish closes this too. Logged, because in a healthy app the gate above
        // catches every real load and this line never appears.
        if !documentReady, navigationAction.navigationType != .linkActivated,
           (url?.scheme ?? "").isEmpty || url?.scheme == "about" {
            AppLog.debug("richhtml", "navigation allowed late", ["rowID": rowID])
            decisionHandler(.allow)
            return
        }
        // A real tap on a link goes through the action delegate, so the
        // controller's ONE routing rule applies (a walnut-file:// link or a
        // bare absolute .html path opens the in-app preview; http(s) opens
        // Safari). The scheme allowlist is why this isn't just forwarded
        // blindly: `tel:`/`sms:`/`mailto:` in model-written markup should not
        // be able to put the phone in a dialer.
        if navigationAction.navigationType == .linkActivated, let url,
           url.scheme == "http" || url.scheme == "https"
            || url.scheme == FilePreviewLink.scheme {
            delegate?.timelineCell(didRequest: .openURL(url))
        } else {
            // Logged because a dropped main-frame navigation is invisible from the
            // outside: a card that self-navigates (the meta refresh, an island
            // assigning `location`) and a tap on a `tel:` link both land here, and so
            // would a state gate that ever refused the initial load — which reads as
            // an empty row with no other trace. URL truncated: a `data:` reference
            // can be megabytes.
            AppLog.debug("richhtml", "navigation blocked",
                         ["rowID": rowID, "type": String(navigationAction.navigationType.rawValue),
                          "url": String((url?.absoluteString ?? "-").prefix(64))])
        }
        // Everything else — a meta refresh, a form post, a redirect, an
        // island script assigning `location` — is dropped, so a card can never
        // navigate itself to another page.
        decisionHandler(.cancel)
    }

    // MARK: - Failure paths

    /// The web content process died under this cell.
    ///
    /// Every rich cell shares ONE ephemeral data store, and WebKit gives a store one
    /// web content process — so a single island's model-authored `while (true)` or a
    /// huge allocation takes down EVERY card on screen, not just its own. What comes
    /// back is a live web view holding no document and no navigation of any kind: no
    /// `didFinish`, no failure, nothing. Left alone the row keeps whatever height it
    /// had and shows nothing at all for the rest of the session.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // An island that is still arriving is showing the placeholder, has no
        // document of its own up, and is already the right height. Nothing to do,
        // and its `loadedBody` is some earlier row's.
        guard !placeholderShown else { return }
        documentReady = false
        awaitingOwnNavigation = false
        // The still frame is a snapshot of a document that no longer exists, and the
        // `didFinish` that would remove it is exactly what is not coming.
        removeCover()
        webView.isHidden = false
        guard processRecoveriesLeft > 0, let body = loadedBody, let kind = loadedKind else {
            AppLog.debug("richhtml", "process gone, giving up", ["rowID": stamp.rowID])
            reportMinimumHeight(reason: "process-terminated")
            return
        }
        processRecoveriesLeft -= 1
        AppLog.debug("richhtml", "process gone, reloading",
                     ["rowID": stamp.rowID, "left": String(processRecoveriesLeft)])
        // Drop the identity FIRST: it says "this document is already up", which is
        // what makes a configure idempotent — and it is now false, so a re-load
        // would be skipped both here and on the next reconfigure. Doing it before
        // the load also keeps `coverDuringLoad` from freezing a frame of the dead
        // document over the recovery.
        displayedIdentity = nil
        let style = traitCollection.userInterfaceStyle
        performLoad(RichHTMLDocument.page(body: body, palette: Self.palette(for: style),
                                          kind: kind),
                    identity: Self.identity(key: documentKey, width: contentWidth, style: style))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error, phase: "didFail")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        handleLoadFailure(error, phase: "didFailProvisional")
    }

    /// A load that will never produce a `didFinish`, and therefore never a height.
    ///
    /// Without this the cell had no failure path at all: `documentReady` stayed
    /// false, the web view stayed hidden or the still frame stayed up, no
    /// measurement was ever taken, and the row sat at its first guess showing
    /// nothing — a blank the reader cannot explain and the app never corrects.
    private func handleLoadFailure(_ error: Error, phase: String) {
        guard !Self.isIgnorableFailure(error) else { return }
        awaitingOwnNavigation = false
        // Not while the placeholder is up: an island that is still arriving must not
        // reveal an empty web view behind "Building interactive block…".
        if !placeholderShown { webView?.isHidden = false }
        removeCover()
        reportMinimumHeight(reason: phase)
    }

    /// Size the row for a document that will never measure itself. The minimum row
    /// height is the honest answer — small, and visibly nothing — where the estimate
    /// it would otherwise keep is a tall empty box.
    private func reportMinimumHeight(reason: String) {
        AppLog.debug("richhtml", "load failed", ["rowID": stamp.rowID, "key": stamp.key,
                                                "reason": reason])
        report(contentHeight: TimelineMetrics.richMinHeight, rowID: stamp.rowID,
               key: stamp.key, width: stamp.width, ignoringReadiness: true)
    }

    /// Failures that must NOT size a row, because nothing actually failed to render
    /// or because another path already owns the case. Domains and codes are spelled
    /// by value on purpose: each is a documented WebKit constant, and one integer is
    /// not worth reaching for the bridged error enums over.
    private static func isIgnorableFailure(_ error: Error) -> Bool {
        let error = error as NSError
        // A load THIS cell superseded: the next streaming tick's `loadHTMLString`
        // cancels the one in flight. Sizing a row from that would collapse a live
        // card to the minimum height several times a second.
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return true }
        // "Frame load interrupted" — what a `.cancel` from the navigation lockdown
        // surfaces as, i.e. a card being correctly stopped from navigating itself.
        if error.domain == "WebKitErrorDomain", error.code == 102 { return true }
        // `WKErrorWebContentProcessTerminated`. The termination callback owns this
        // one and re-loads; flashing the card away to nothing in between would be
        // visible on a crash that heals.
        return error.domain == "WKErrorDomain" && error.code == 2
    }
}
