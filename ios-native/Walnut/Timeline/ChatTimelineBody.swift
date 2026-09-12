import SwiftUI

/// ChatStore → TimelineHost binding: the replacement for ChatView's
/// MessageListView scroll body. Same shape as SessionTimelineBody; the
/// Personal AI chat adds the load-earlier affordance and the redacted
/// placeholder while the first canonical load is in flight.
struct ChatTimelineBody: View {
    let chat: ChatStore
    var repinSignal: Int = 0
    var keyboardGeometryFrozen: () -> Bool = { false }
    var onRefresh: (() async -> Void)? = nil

    @State private var previewTarget: FilePreviewTarget?
    /// Non-HTML file taps: the text viewer, anchored to the referenced line.
    @State private var textTarget: TextFileTarget?
    /// Extensionless path taps: the directory browser, rooted there.
    @State private var dirTarget: DirectoryTarget?
    /// A tapped thinking / tool row — presented in the SAME sheet the session
    /// surface uses, so "tap to see it all" cannot behave differently here.
    @State private var activityDetail: TimelineActivityDetail?

    var body: some View {
        // LAYER ORDER IS LOAD-BEARING (DOCK-c, 2026-08-29). The empty state used to be
        // the FIRST child, i.e. under `TimelineHost` — and `TimelineHost` is a
        // `UICollectionView` filling the whole area, so every touch aimed at the
        // placeholder went to the (empty) transcript instead. At accessibility sizes
        // the placeholder degrades to a SCROLL to keep every word reachable
        // (`TimelinePlaceholderInset`), and a scroll view that cannot be touched is
        // just a truncation with extra steps. The placeholder is painted LAST now, and
        // it only takes touches when it is actually scrollable, so pull-to-refresh on
        // an empty transcript still works.
        ZStack {
            TimelineHost(
                messages: chat.messages,
                streaming: chat.streaming,
                liveText: chat.streamText,
                liveTextTruncated: chat.streamTextTruncated,
                liveThinking: chat.liveThinking,
                liveTools: chat.liveTools,
                activity: chat.activity,
                // Reading activeID here is what makes a conversation switch
                // visible to the timeline at all: the host outlives the switch,
                // and the server's positional message ids ("m0"…) are identical
                // between two conversations of the same length.
                scope: TimelineScope.sanitize(chat.activeID),
                showLoadEarlier: chat.hasOlder,
                scrollToBottomSignal: chat.scrollToBottomSignal + repinSignal,
                isPinned: { chat.bottomPinned },
                setPinned: { chat.bottomPinned = $0 },
                geometryFrozen: keyboardGeometryFrozen,
                onAction: { action in
                    switch action {
                    case .retry(let messageID):
                        if let message = chat.messages.first(where: { $0.id == messageID }) {
                            Task { await chat.retry(message) }
                        }
                    case .discard(let messageID):
                        if let message = chat.messages.first(where: { $0.id == messageID }) {
                            chat.discardFailed(message)
                        }
                    case .loadEarlier:
                        Task { await chat.loadOlder() }
                    case .openActivity(let detail):
                        activityDetail = detail
                    case .previewFile(let ref):
                        // Personal AI chat always runs on the primary box.
                        // HTML keeps the rendered WKWebView preview (and its dock
                        // seat); every other extension is text, where a line
                        // number means something; extensionless is a folder.
                        if ref.looksLikeDirectory {
                            dirTarget = DirectoryTarget(path: ref.path, host: nil)
                        } else if FilePreviewLink.isPreviewablePath(ref.path) {
                            previewTarget = FilePreviewTarget(path: ref.path, host: nil)
                        } else {
                            textTarget = TextFileTarget(ref: ref, host: nil)
                        }
                    default:
                        break
                    }
                },
                onRefresh: onRefresh
            )
            // A conversation whose first page has not resolved gets a SKELETON, not
            // white space, and not the "listening" empty state either — that state
            // is a claim about an empty conversation, and during a switch it is a
            // claim we cannot make yet.
            if chat.messages.isEmpty && chat.firstPageInFlight {
                ChatTimelineSkeleton()
            } else if chat.messages.isEmpty && !chat.loadingMessages && !chat.streaming {
                ChatTimelineEmptyState()
            }
        }
        // First open only (a link tap in the transcript). Collapsing this sheet
        // banks the scroll position and leaves the report in the app-level dock
        // bar; REOPENING is presented by `FilePreviewDockOverlay`, so it works
        // from any tab and not just from the page the link was on.
        .sheet(item: $previewTarget) { target in
            HTMLFilePreviewSheet(target: target)
        }
        // No cwd/sessionID here: the Personal AI chat has no working directory of
        // its own, so a stale path can't be re-resolved from this surface. It
        // still opens honestly, and reports honestly when it can't.
        .sheet(item: $textTarget) { target in
            SessionFileViewer(name: target.ref.displayName, path: target.ref.path,
                              host: target.host ?? "", ref: target.ref)
        }
        .sheet(item: $dirTarget) { target in
            DirectoryPreviewSheet(target: target)
        }
        .sheet(item: $activityDetail) { detail in
            TimelineActivitySheet(detail: detail)
        }
    }
}

/// What a conversation looks like while its first page is still being read.
///
/// Measured cold on a 200-row page (2026-09-12 gate): 3.23 SECONDS of pure white,
/// 1845ms of it the server's first JSONL parse. Nothing can paint sooner — the rows
/// genuinely do not exist yet — so the fix is not speed, it is telling the truth
/// while waiting. Shaped like a transcript (alternating assistant lines and a
/// right-aligned bubble, plus a chip row) so the wait previews the thing arriving
/// rather than being a generic spinner in the middle of the screen.
///
/// `.redacted(.placeholder)` does the drawing: same treatment the rest of the app
/// uses for unresolved content, so it dims and shimmers with the system rather than
/// with hand-rolled colours. It takes NO touches — pull-to-refresh on the transcript
/// underneath has to keep working, and there is nothing here to tap.
struct ChatTimelineSkeleton: View {
    /// Widths as fractions of the content width, so the bars read as sentences
    /// rather than as a bar chart.
    private static let assistantRuns: [[CGFloat]] = [
        [0.92, 0.78, 0.44],
        [0.86, 0.62],
        [0.9, 0.83, 0.7, 0.35],
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(Self.assistantRuns.enumerated()), id: \.offset) { index, run in
                if index > 0 { userBubble }
                chipRow
                assistantRun(run)
            }
        }
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.top, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .redacted(reason: .placeholder)
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("chat.skeleton")
        .accessibilityLabel("Loading the conversation")
    }

    private func assistantRun(_ widths: [CGFloat]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(widths.enumerated()), id: \.offset) { _, fraction in
                bar(fraction)
            }
        }
    }

    private var userBubble: some View {
        HStack {
            Spacer(minLength: TimelineMetrics.bubbleLeadingGap)
            RoundedRectangle(cornerRadius: TimelineMetrics.bubbleCorner, style: .continuous)
                .fill(Color(.tertiarySystemFill))
                .frame(height: 34)
                .frame(maxWidth: .infinity)
        }
    }

    private var chipRow: some View {
        Capsule()
            .fill(Color(.tertiarySystemFill))
            .frame(width: 130, height: 21)
    }

    private func bar(_ fraction: CGFloat) -> some View {
        GeometryReader { geo in
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color(.tertiarySystemFill))
                .frame(width: geo.size.width * fraction, height: 12)
        }
        .frame(height: 12)
    }
}

struct ChatTimelineEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Your Personal AI is listening")
                .font(.headline)
                // Both lines WRAP now instead of truncating (see
                // `TimelinePlaceholderInset`, round 2): at accessibility sizes the
                // headline was rendering as "Your Personal…". Wrapped copy has to be
                // centred and kept off the screen edges, or the fix trades an
                // ellipsis for a ragged left edge against the bezel.
                .multilineTextAlignment(.center)
            Text("Ask anything — tasks, notes, or what happened today.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .timelinePlaceholderInset(vertical: 120)
        .padding(.horizontal, 24)
    }
}
