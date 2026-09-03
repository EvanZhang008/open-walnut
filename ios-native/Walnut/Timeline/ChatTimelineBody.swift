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
                activity: chat.activity,
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
            if chat.messages.isEmpty && !chat.loadingMessages && !chat.streaming {
                ChatTimelineEmptyState()
            }
        }
        .redacted(reason: chat.loadingMessages && chat.messages.isEmpty ? .placeholder : [])
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
