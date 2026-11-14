import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// A Talk to Walnut take on the Lock Screen and in the Dynamic Island: what it
/// is doing, how long it has listened, and while it listens a big Send (the
/// take ends only when the person says so, and Walnut stays closed) and a small
/// Cancel.
struct TalkLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TalkActivityAttributes.self) { context in
            // A solid dark card with light words, whatever the wallpaper: a pale card took
            // the Lock Screen's white text and read at about 1:1 on a light wallpaper.
            TalkLockScreenView(state: context.state)
                .environment(\.colorScheme, .dark)
                .activityBackgroundTint(Color.black.opacity(0.82))
                .activitySystemActionForegroundColor(.white)
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
                            .lineLimit(state.phase == .listening ? 1 : 2)
                            .multilineTextAlignment(.center)
                        if state.phase == .listening { TalkButtons(copy: state.copy == true) }
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
                            .lineLimit(state.phase == .listening ? 1 : 3)
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
            if state.phase == .listening { TalkButtons(copy: state.copy == true) }
        }
        .padding(14)
    }
}

/// Send now / Cancel, run in the app's process (LiveActivityIntent). Send is the
/// big one, easy to hit without looking (the user, 2026-11-07: "a button that is
/// very easy to press"); Cancel is small, so it is not hit by mistake.
struct TalkButtons: View {
    /// A dictation: the big button reads Done, and its page then offers Send and Copy.
    var copy = false

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: TalkCancelIntent()) {
                Image(systemName: "xmark")
                    .font(.headline)
                    .frame(width: 30, height: 30)
            }
            .tint(.gray)
            .accessibilityLabel("Cancel")
            Button(intent: TalkSendNowIntent()) {
                // A Live Activity is at most 160 pt tall: with the button's own padding
                // this keeps Send about 44 pt high, the title and one line above it.
                Label(copy ? "Done" : "Send", systemImage: copy ? "checkmark" : "arrow.up")
                    .font(.title3.weight(.bold))
                    .frame(maxWidth: .infinity, minHeight: 30)
            }
            // Walnut's own brown (its accent), as in the app, not a system orange.
            .tint(Color(red: 0x8B / 255, green: 0x5A / 255, blue: 0x2B / 255))
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 14))
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
        case .transcribing, .sending: return state.copy == true ? "Getting" : "Sending"
        case .sent: return state.copy == true ? "Ready" : "Sent"
        case .failed:
            if state.later == true { return "Waiting" }
            if state.quiet == true { return "No words" }
            return state.copy == true ? "Failed" : "Not sent"
        }
    }
}
