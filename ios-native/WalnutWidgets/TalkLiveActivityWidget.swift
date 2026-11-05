import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// A Talk to Walnut take on the Lock Screen and in the Dynamic Island: what it
/// is doing, how long it has listened, and Send / Cancel while it listens.
struct TalkLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TalkActivityAttributes.self) { context in
            TalkLockScreenView(state: context.state)
                .activityBackgroundTint(Color(.systemBackground).opacity(0.9))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: state.symbol)
                        .font(.title2)
                        .foregroundStyle(TalkStyle.tint(state))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if state.phase == .listening {
                        Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                            .monospacedDigit()
                            .font(.headline)
                            .frame(maxWidth: 64)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(state.title).font(.headline)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 8) {
                        // The island is always black: grey secondary text there is hard to read.
                        Text(state.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.85))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                        if state.phase == .listening { TalkButtons() }
                    }
                }
            } compactLeading: {
                Image(systemName: state.symbol).foregroundStyle(TalkStyle.tint(state))
            } compactTrailing: {
                // One view per phase, swapped with no cross-fade: the timer and
                // "Sending" must never draw over each other in this small spot.
                Group {
                    if state.phase == .listening {
                        Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                            .monospacedDigit()
                            .frame(maxWidth: 40)
                    } else {
                        Text(TalkStyle.shortWord(state)).font(.caption2)
                    }
                }
                .id(state.phase)
                .transition(.identity)
                .contentTransition(.identity)
            } minimal: {
                Image(systemName: state.symbol).foregroundStyle(TalkStyle.tint(state))
            }
        }
    }
}

struct TalkLockScreenView: View {
    let state: TalkActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: state.symbol)
                    .font(.title2)
                    .foregroundStyle(TalkStyle.tint(state))
                VStack(alignment: .leading, spacing: 2) {
                    Text(state.title).font(.headline)
                    if !state.subtitle.isEmpty {
                        Text(state.subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                }
                Spacer(minLength: 0)
                if state.phase == .listening {
                    Text(timerInterval: state.startedAt...Date.distantFuture, countsDown: false)
                        .monospacedDigit()
                        .font(.headline)
                        .frame(maxWidth: 64, alignment: .trailing)
                }
            }
            if state.phase == .listening { TalkButtons() }
        }
        .padding(16)
    }
}

/// Send now / Cancel, run in the app's process (LiveActivityIntent).
struct TalkButtons: View {
    var body: some View {
        HStack(spacing: 10) {
            Button(intent: TalkCancelIntent()) {
                Label("Cancel", systemImage: "xmark")
                    .frame(maxWidth: .infinity)
            }
            .tint(.gray)
            Button(intent: TalkSendNowIntent()) {
                Label("Send", systemImage: "arrow.up")
                    .frame(maxWidth: .infinity)
            }
            .tint(.orange)
        }
        .buttonStyle(.borderedProminent)
        .font(.subheadline.weight(.semibold))
    }
}

enum TalkStyle {
    static func tint(_ state: TalkActivityAttributes.ContentState) -> Color {
        switch state.phase {
        case .listening: return .orange
        case .transcribing, .sending: return .blue
        case .sent: return .green
        case .failed:
            if state.later == true { return .yellow }
            if state.quiet == true { return .gray }
            return .red
        }
    }

    static func shortWord(_ state: TalkActivityAttributes.ContentState) -> String {
        switch state.phase {
        case .listening: return ""
        case .transcribing, .sending: return "Sending"
        case .sent: return "Sent"
        case .failed:
            if state.later == true { return "Waiting" }
            if state.quiet == true { return "No words" }
            return "Not sent"
        }
    }
}
