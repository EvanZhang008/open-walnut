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
    /// Extra scroll-to-bottom pulses from the page (keyboard repin).
    var repinSignal: Int = 0
    /// Keyboard transition freeze from KeyboardBottomRepin.
    var keyboardGeometryFrozen: () -> Bool = { false }
    /// Pull-to-refresh (SwiftUI .refreshable can't reach the hosted list).
    var onRefresh: (() async -> Void)? = nil

    @State private var previewTarget: FilePreviewTarget?

    var body: some View {
        // LAYER ORDER IS LOAD-BEARING (DOCK-c, 2026-08-29) — same fix as
        // `ChatTimelineBody`, see the note there. The placeholders used to sit UNDER
        // `TimelineHost`'s collection view, so the AX-size degrade-to-scroll could
        // never be touched; they are painted LAST now and take touches only while they
        // are genuinely scrollable.
        ZStack {
            TimelineHost(
                messages: store.messages,
                streaming: store.streaming,
                liveText: store.liveText,
                liveTextTruncated: store.liveTextTruncated,
                activity: store.activity,
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
                    case .previewFile(let path):
                        previewTarget = FilePreviewTarget(path: path, host: previewHost)
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
                if store.loadedOnce || store.transcriptMissing {
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
