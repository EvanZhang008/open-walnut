import SwiftUI

/// ChatStore → TimelineHost binding: the replacement for ChatView's
/// MessageListView scroll body. Same shape as SessionTimelineBody; the
/// butler chat adds the load-earlier affordance and the redacted
/// placeholder while the first canonical load is in flight.
struct ChatTimelineBody: View {
    let chat: ChatStore
    var repinSignal: Int = 0
    var keyboardGeometryFrozen: () -> Bool = { false }
    var onRefresh: (() async -> Void)? = nil

    var body: some View {
        ZStack {
            if chat.messages.isEmpty && !chat.loadingMessages && !chat.streaming {
                ChatTimelineEmptyState()
            }
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
                    default:
                        break
                    }
                },
                onRefresh: onRefresh
            )
        }
        .redacted(reason: chat.loadingMessages && chat.messages.isEmpty ? .placeholder : [])
    }
}

struct ChatTimelineEmptyState: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Your butler is listening")
                .font(.headline)
            Text("Ask anything — tasks, notes, or what happened today.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 120)
    }
}
