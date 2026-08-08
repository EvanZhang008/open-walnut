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
    /// Extra scroll-to-bottom pulses from the page (keyboard repin).
    var repinSignal: Int = 0
    /// Keyboard transition freeze from KeyboardBottomRepin.
    var keyboardGeometryFrozen: () -> Bool = { false }
    /// Pull-to-refresh (SwiftUI .refreshable can't reach the hosted list).
    var onRefresh: (() async -> Void)? = nil

    var body: some View {
        ZStack {
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
                    default:
                        break
                    }
                },
                onRefresh: onRefresh
            )
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
        .padding(.vertical, 120)
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
            Text("Send a message to pick up where this session left off.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 100)
        .padding(.horizontal, 32)
    }
}
