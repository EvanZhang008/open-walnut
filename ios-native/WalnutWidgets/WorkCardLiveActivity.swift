import ActivityKit
import SwiftUI
import WidgetKit

/// The lock-screen work card and its Dynamic Island: Working, Needs you and Completed, each a
/// link to its list in the app. Drawn from `WorkCardAttributes.ContentState`, which the server
/// keeps current with silent pushes (src/core/push/work-card.ts); a card that heard nothing for
/// a while (the Mac asleep) says how old its numbers are instead of passing them off as now.
struct WorkCardLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: WorkCardAttributes.self) { context in
            WorkCardLockScreen(state: context.state, isStale: context.isStale)
                .widgetURL(WorkCardLink.url(context.state.primaryList))
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 5) {
                        WorkCardMark(size: 18)
                        Text("Walnut")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(WorkCardStyle.brand(dark: true))
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    // Narrow here: the tiles below already say what is counted.
                    WorkCardFreshness(state: s, isStale: context.isStale, short: true)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // The lock-screen card's three tiles, the same size, each its own link.
                    WorkCardIslandBottom(state: s, isStale: context.isStale)
                }
            } compactLeading: {
                // Whose island this is: the app's own mark.
                WorkCardMark(size: 20)
            } compactTrailing: {
                // One count, the list a tap on the island opens (Needs you when anything does).
                WorkCardCompact(list: s.primaryList, count: s.count(s.primaryList))
            } minimal: {
                WorkCardCompact(list: s.primaryList, count: s.count(s.primaryList))
            }
            .widgetURL(WorkCardLink.url(s.primaryList))
            .keylineTint(WorkCardStyle.color(s.primaryList, dark: true))
        }
    }
}

/// The card's colours: the app's state colours (UserStatePill), readable on the lock screen in
/// both appearances; the Dynamic Island is always black, so it takes the dark ones.
enum WorkCardStyle {
    static func color(_ list: WorkCardList, dark: Bool) -> Color {
        switch list {
        case .working: return dark ? Color(red: 0.50, green: 0.66, blue: 1.00) : Color(red: 0.11, green: 0.31, blue: 0.77)
        case .needs: return dark ? Color(red: 1.00, green: 0.60, blue: 0.36) : Color(red: 0.70, green: 0.23, blue: 0.02)
        case .completed: return dark ? Color(red: 0.30, green: 0.85, blue: 0.39) : Color(red: 0.09, green: 0.42, blue: 0.17)
        }
    }

    /// A tile's fill under a count: Needs you, the one that asks for the user, the strongest.
    static func fill(_ list: WorkCardList) -> Double { list == .needs ? 0.38 : 0.24 }

    /// A count as the card draws it: "99+" past two digits, so the island never widens.
    static func number(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }

    static func brand(dark: Bool) -> Color {
        dark ? Color(red: 0.79, green: 0.59, blue: 0.35) : Color(red: 0.55, green: 0.35, blue: 0.17)
    }
}

/// The app icon, small: the island's compact view has no room for the name.
struct WorkCardMark: View {
    let size: CGFloat

    var body: some View {
        Image("WalnutMark")
            .resizable()
            .interpolation(.high)
            .frame(width: size, height: size)
            .accessibilityLabel("Walnut")
    }
}

struct WorkCardLockScreen: View {
    let state: WorkCardAttributes.ContentState
    let isStale: Bool
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                WorkCardMark(size: 18)
                Text("Walnut")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(WorkCardStyle.brand(dark: dark))
                Spacer(minLength: 8)
                WorkCardFreshness(state: state, isStale: isStale)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            WorkCardTiles(state: state, dark: dark, dimmed: isStale, spacing: 8)
            WorkCardNeedsLine(state: state, dark: dark)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// Said only when the numbers are not live: "Finished 10:20" on an ended card's last face, "Not
/// updated since 9:41" (with the day once that is not today) once the card heard nothing for a
/// while. A live card says no time: the server redraws it only when a number changes, so the
/// time of its last redraw is not when its numbers were last true, and the lock screen's clock
/// is right above it. When Completed began counting is said in its own tile.
struct WorkCardFreshness: View {
    let state: WorkCardAttributes.ContentState
    let isStale: Bool
    /// The island's narrow corner: "Since 9:41" when stale (the tiles dim to say so).
    var short = false

    var body: some View {
        if let ended = state.endedDate {
            Text("Finished \(Self.when(ended))")
        } else if isStale {
            Text(short ? "Since \(Self.when(state.updatedDate))" : "Not updated since \(Self.when(state.updatedDate))")
        }
    }

    static func when(_ date: Date, now: Date = Date()) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}

/// The three counts, the same size, each its own link.
struct WorkCardTiles: View {
    let state: WorkCardAttributes.ContentState
    let dark: Bool
    let dimmed: Bool
    let spacing: CGFloat

    var body: some View {
        HStack(spacing: spacing) {
            ForEach(WorkCardList.allCases) { list in
                Link(destination: WorkCardLink.url(list)) {
                    WorkCardTile(list: list, count: state.count(list), dark: dark, dimmed: dimmed,
                                 caption: list == .completed ? "since \(WorkCardFreshness.when(state.sinceDate))" : nil)
                }
            }
        }
        // One height for all three, the tallest (Completed, with its start time).
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct WorkCardTile: View {
    let list: WorkCardList
    let count: Int
    let dark: Bool
    let dimmed: Bool
    /// Under the name: Completed's "since 9:41".
    var caption: String? = nil

    var body: some View {
        let tint = WorkCardStyle.color(list, dark: dark)
        VStack(alignment: .leading, spacing: 1) {
            Text(WorkCardStyle.number(count))
                .font(.title.weight(.bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(count > 0 ? tint : Color.primary.opacity(0.55))
                .contentTransition(.numericText(value: Double(count)))
            Text(list.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(Color.primary.opacity(0.78))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if let caption {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(Color.primary.opacity(0.6))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        // A zero is a quiet neutral tile, still a visible target; a count wears its colour.
        .background(count > 0 ? tint.opacity(WorkCardStyle.fill(list)) : Color.primary.opacity(0.12),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(dimmed ? 0.6 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) \(list.label)")
        .accessibilityValue(caption ?? "")
    }
}

/// The newest task that needs the user, and how many more do ("+2").
struct WorkCardNeedsLine: View {
    let state: WorkCardAttributes.ContentState
    let dark: Bool

    var body: some View {
        if let title = state.needsTitle, state.needs > 0 {
            // The title is one task: it opens that task, over the Needs you list.
            Link(destination: WorkCardLink.url(.needs, task: state.needsTaskId)) {
                HStack(spacing: 5) {
                    Image(systemName: WorkCardList.needs.systemImage)
                        .foregroundStyle(WorkCardStyle.color(.needs, dark: dark))
                    Text(title)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                        // Hidden on a locked phone when the user keeps lock-screen details private.
                        .privacySensitive()
                    if state.needs > 1 {
                        Text("+\(WorkCardStyle.number(state.needs - 1))")
                            .foregroundStyle(Color.primary.opacity(0.6))
                            .layoutPriority(1)
                    }
                }
                .font(.footnote)
            }
            .accessibilityLabel(state.needs > 1 ? "Needs you: \(title), and \(state.needs - 1) more" : "Needs you: \(title)")
        }
    }
}

struct WorkCardCompact: View {
    let list: WorkCardList
    let count: Int

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: list.systemImage)
            Text(WorkCardStyle.number(count)).monospacedDigit()
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(count > 0 ? WorkCardStyle.color(list, dark: true) : Color.secondary)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(count) \(list.label)")
    }
}

struct WorkCardIslandBottom: View {
    let state: WorkCardAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WorkCardTiles(state: state, dark: true, dimmed: isStale, spacing: 6)
            // In from the island's rounded corner, which clipped its mark at the tiles' inset.
            WorkCardNeedsLine(state: state, dark: true)
                .padding(.horizontal, 10)
        }
        .padding(.horizontal, 4)
        .padding(.top, 2)
    }
}
