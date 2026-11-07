import SwiftUI

/// SessionConversationStore → TimelineHost binding: the replacement for
/// SessionConversationView's ScrollView+LazyVStack message list. Reads the
/// store's observable fields HERE (so this small view re-evaluates on
/// changes — an O(1) struct build, no child tree to diff) and forwards a
/// plain snapshot into the UIKit timeline.
///
/// The keyboard/programmatic geometry-freeze intent model stays with the
/// page (KeyboardBottomRepin) — this body only consumes the frozen flag and
/// exposes repin via `repinSignal`.
struct SessionTimelineBody: View {
    let store: SessionConversationStore
    /// Exec host for file-preview links ("" / nil = the primary box) — the
    /// raw file-content fetch must read the SESSION's disk, not the Mac's.
    var previewHost: String? = nil
    /// The session's working directory + id. Passed so a tapped path that does
    /// NOT exist can be re-resolved host-side (`files/resolve-path`) and
    /// retried: a path written from another cwd, or a file that has since moved,
    /// is the common case, not the exotic one.
    var previewCwd: String? = nil
    var previewSessionID: String? = nil
    /// Main's or a lead's chat: replies show the tasks they are about (`TimelineInput`).
    var showMessageAbout: Bool = false
    /// Extra scroll-to-bottom pulses from the page (keyboard repin).
    var repinSignal: Int = 0
    /// Keyboard transition freeze from KeyboardBottomRepin.
    var keyboardGeometryFrozen: () -> Bool = { false }
    /// Pull-to-refresh (SwiftUI .refreshable can't reach the hosted list).
    var onRefresh: (() async -> Void)? = nil
    /// The messages waiting in the session's queue: they are listed above the composer, so
    /// their bubbles stay out of the conversation until they start going out.
    var queue: SessionQueueModel? = nil

    @State private var previewTarget: FilePreviewTarget?
    /// Non-HTML file taps: the text viewer, anchored to the referenced line.
    @State private var textTarget: TextFileTarget?
    /// Extensionless path taps: the directory browser, rooted there.
    @State private var dirTarget: DirectoryTarget?
    /// A tapped thinking / tool row — the SAME sheet the Personal AI chat
    /// presents, from the same action, so the two surfaces cannot drift.
    @State private var activityDetail: TimelineActivityDetail?
    /// A tapped task mention (`walnut-task://`): the task sheet a letter's task
    /// reference opens, so a task reads the same wherever it was cited.
    @State private var openedTask: TaskOpenTarget?

    /// The queue rows by the id of the message they hold (the bubble's `clientMessageId`).
    private var queueRowsByMessage: [String: SessionQueuedMessage] {
        guard let queue, queue.hasRows else { return [:] }
        return Dictionary(queue.rows.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// A message in the queue lives in the tray above the composer, once: its bubble joins
    /// the conversation when the queue lets go of it, and the transcript's own row
    /// replaces that. Two copies of one message, each with its own controls, read as
    /// two messages.
    private var visibleMessages: [ChatMessage] {
        let rows = queueRowsByMessage
        guard !rows.isEmpty else { return store.messages }
        return store.messages.filter { message in
            guard let id = message.clientMessageId else { return true }
            return !Self.queueHolds(rows[id])
        }
    }

    /// A queue row keeps its message's bubble off the page only while it still waits: once
    /// the CLI took it (`isDelivered`), the bubble is in the conversation, where the
    /// transcript's own row replaces it.
    static func queueHolds(_ row: SessionQueuedMessage?) -> Bool {
        guard let row else { return false }
        return !row.isDelivered
    }

    var body: some View {
        // LAYER ORDER IS LOAD-BEARING (DOCK-c, 2026-08-29) — same fix as
        // `ChatTimelineBody`, see the note there. The placeholders used to sit UNDER
        // `TimelineHost`'s collection view, so the AX-size degrade-to-scroll could
        // never be touched; they are painted LAST now and take touches only while they
        // are genuinely scrollable.
        ZStack {
            TimelineHost(
                messages: visibleMessages,
                streaming: store.streaming,
                liveText: store.liveText,
                liveTextTruncated: store.liveTextTruncated,
                liveThinking: store.liveThinking,
                liveTools: store.liveTools,
                activity: store.activity,
                // Session transcripts are numbered per session, so a session's
                // rows must live in that session's id space (see TimelineScope).
                scope: TimelineScope.sanitize(previewSessionID),
                // Older pages, when the server pages this transcript: a busy turn
                // folds into one line, and the conversation above it is one tap away.
                showLoadEarlier: store.showsLoadEarlier,
                loadEarlierState: store.loadEarlierState,
                afterLiveMessageIDs: store.afterLiveMessageIDs,
                // The server's "always show what Walnut added"; off, each bubble's
                // long-press item shows it for that message (TimelineTurnFold).
                showWalnutAdditions: WalnutAdditionsSetting.shared.showAll,
                showMessageAbout: showMessageAbout,
                scrollToBottomSignal: store.scrollToBottomSignal + repinSignal,
                isPinned: { store.bottomPinned },
                setPinned: { store.bottomPinned = $0 },
                geometryFrozen: keyboardGeometryFrozen,
                onAction: { action in
                    switch action {
                    case .retry(let messageID):
                        if let message = store.messages.first(where: { $0.id == messageID }) {
                            Task { await store.retry(message) }
                        }
                    case .discard(let messageID):
                        if let message = store.messages.first(where: { $0.id == messageID }) {
                            store.discardFailed(message)
                        }
                    case .loadEarlier:
                        Task { await store.loadEarlier() }
                    case .openActivity(let detail):
                        activityDetail = detail
                    case .openTask(let id):
                        openedTask = TaskOpenTarget(
                            id: id, title: TaskMentionResolver.shared.title(for: id))
                    case .previewFile(let ref):
                        // HTML keeps the rendered WKWebView preview (and its dock
                        // seat); every other extension is text, where a line
                        // number means something; extensionless is a folder.
                        // Looked up first: a path on another host opens from there.
                        Task { @MainActor in
                            switch await ClickedPath.locate(ref, host: previewHost, cwd: previewCwd,
                                                            sessionID: previewSessionID) {
                            case .directory(let target): dirTarget = target
                            case .html(let target): previewTarget = target
                            case .text(let target): textTarget = target
                            }
                        }
                    case .sendIslandResult(let text, let reply):
                        // The user pressed Send on an island's result: the exact text,
                        // through the composer's own send, as their message.
                        Task { reply(await store.sendFromComposer(text)) }
                    default:
                        break
                    }
                },
                onRefresh: onRefresh
            )
            if store.messages.isEmpty && !store.streaming {
                // Loading until the first transcript answer; empty state for
                // BOTH "no tail exported" and "tail with zero renderable rows"
                // (same conditions as the original page).
                if store.transcriptUnreadable && !store.loadedOnce {
                    SessionTimelineUnreadableState(onRetry: onRefresh)
                } else if store.loadedOnce || store.transcriptMissing {
                    SessionTimelineEmptyState()
                } else {
                    SessionTimelineLoadingState()
                }
            }
        }
        // First open only (a link tap in the transcript). Collapsing this sheet
        // banks the scroll position and leaves the report in the app-level dock
        // bar; REOPENING is presented by `FilePreviewDockOverlay`, so it works
        // from any tab and not just from the page the link was on.
        .sheet(item: $previewTarget) { target in
            HTMLFilePreviewSheet(target: target)
        }
        .sessionFileSheet(item: $textTarget) { target in
            SessionFileViewer(name: target.ref.displayName, path: target.ref.path,
                              host: target.host ?? "", ref: target.ref,
                              cwd: target.cwd, sessionID: target.sessionID,
                              hostNote: target.hostNote, missingNote: target.missing)
        }
        .sheet(item: $dirTarget) { target in
            DirectoryPreviewSheet(target: target)
        }
        .sheet(item: $activityDetail) { detail in
            TimelineActivitySheet(detail: detail)
        }
        .sheet(item: $openedTask) { destination in
            TaskSessionSheet(target: destination)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .task { await WalnutAdditionsSetting.shared.refreshIfStale() }
    }
}

struct SessionTimelineLoadingState: View {
    var body: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading conversation…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .timelinePlaceholderInset(vertical: 120)
    }
}

/// The transcript could not be read (its host is out of reach, the phone is offline): never
/// "No transcript yet", which reads as a task that did nothing. The store keeps retrying.
struct SessionTimelineUnreadableState: View {
    var onRetry: (() async -> Void)?
    @State private var retrying = false
    /// A retry finished and this page is still here, so it failed again: say so, or the tap
    /// looks like it did nothing.
    @State private var triedAgain: Date?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.icloud")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Can't load this conversation")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Its computer can't be read right now. Walnut keeps trying.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let onRetry {
                Button {
                    retrying = true
                    triedAgain = nil
                    Task { await onRetry(); retrying = false; triedAgain = Date() }
                } label: {
                    if retrying { ProgressView() } else { Text("Try Again") }
                }
                .buttonStyle(.bordered)
                .disabled(retrying)
                .accessibilityIdentifier("session.transcript.retry")
                if let triedAgain {
                    // The time changes with every retry, so a second tap shows it ran too.
                    Text("Still can't read it at \(triedAgain.formatted(date: .omitted, time: .shortened)). Try again in a moment.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("session.transcript.retryFailed")
                }
            }
        }
        .frame(maxWidth: .infinity)
        .timelinePlaceholderInset(vertical: 100, interactive: onRetry != nil)
        .padding(.horizontal, 32)
        .accessibilityIdentifier("session.transcript.unreadable")
    }
}

struct SessionTimelineEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "terminal")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("No transcript yet")
                .font(.headline)
                // Wraps rather than truncates at accessibility sizes, same rule as
                // the chat empty state (see `TimelinePlaceholderInset`, round 2).
                .multilineTextAlignment(.center)
            Text("Send a message to pick up where this session left off.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .timelinePlaceholderInset(vertical: 100)
        .padding(.horizontal, 32)
    }
}
