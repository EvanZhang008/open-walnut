import SwiftUI

/// The Inbox filter row: All, Unread (count), Action needed (count), then one
/// chip per remaining letter type. A horizontal rail so every chip keeps its
/// full label at the largest text size instead of squeezing. The rail fades at
/// the edge it continues past, so a chip cut at the screen's edge reads as "more
/// this way", and the selected chip is scrolled into view on appear and on every
/// pick, so a filter remembered from last launch is never hidden off the edge.
///
/// Chips are the app's one chip (`WalnutChipStyle`): round, the picked one in the
/// light blue with a hairline.
struct InboxFilterBar: View {
    let selection: InboxFilter
    let count: (InboxFilter) -> Int?
    let onSelect: (InboxFilter) -> Void

    /// How far the rail has scrolled from its leading edge, and how much is left past its
    /// trailing edge: each side fades only while there is more that way.
    @State private var overflow = RailOverflow()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Space.sm) {
                    ForEach(InboxFilter.allCases) { filter in
                        chip(filter).id(filter)
                    }
                }
                .padding(.horizontal, Theme.Space.lg)
                .padding(.vertical, Theme.Space.sm)
            }
            .onScrollGeometryChange(for: RailOverflow.self) { geometry in
                RailOverflow(
                    leading: geometry.contentOffset.x + geometry.contentInsets.leading > 1,
                    trailing: geometry.contentSize.width - geometry.contentOffset.x - geometry.containerSize.width > 1
                )
            } action: { _, now in
                overflow = now
            }
            .mask(RailFade(overflow: overflow))
            .onAppear { proxy.scrollTo(selection, anchor: .center) }
            .onChange(of: selection) { _, now in
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(now, anchor: .center) }
            }
        }
        .background(.bar)
        // An explicit hairline, not Divider(): as a List section header the
        // Divider took the vertical axis and drew a line down the middle.
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color(uiColor: .separator)).frame(height: 0.5)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.filterBar")
    }

    private func chip(_ filter: InboxFilter) -> some View {
        let isSelected = filter == selection
        let value = count(filter)
        return Button {
            guard !isSelected else { return }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            onSelect(filter)
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Text(filter.title)
                if let value {
                    Text(value.formatted(.number))
                        .font(Theme.TextSize.xs.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.secondaryOnCard)
                }
            }
        }
        .buttonStyle(.walnutChip(selected: isSelected))
        .accessibilityIdentifier("inbox.filter.\(filter.rawValue)")
        // The visible words stay the label (a matcher or a person looking for
        // "Unread" must find it); the count rides as the value.
        .accessibilityLabel(filter.title)
        .accessibilityValue(value.map { "\($0)" } ?? "")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : [.isButton])
    }
}

/// Whether a sideways rail has more past each edge.
struct RailOverflow: Equatable {
    var leading = false
    var trailing = false
}

/// A rail's mask: opaque, fading over its last 24 pt on each side that has more.
struct RailFade: View {
    let overflow: RailOverflow
    static let width: CGFloat = 24

    var body: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                .frame(width: overflow.leading ? Self.width : 0)
            Rectangle().fill(.black)
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                .frame(width: overflow.trailing ? Self.width : 0)
        }
    }
}

/// The line under the filter row while a filter other than All is on (a pick
/// remembered from last launch included): which filter hides letters, how many
/// letters there are in all, and the way back, so the list never silently shows
/// less than the inbox holds.
struct InboxFilterOnNotice: View {
    let filter: InboxFilter
    let total: Int
    let showAll: () -> Void

    static func text(filter: InboxFilter, total: Int) -> String {
        "Showing \(filter.title) only (\(total) \(total == 1 ? "letter" : "letters") in all)"
    }

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "line.3.horizontal.decrease.circle")
                .foregroundStyle(Theme.secondaryOnCard)
                .accessibilityHidden(true)
            Text(Self.text(filter: filter, total: total))
                .font(Theme.TextSize.md)
                .foregroundStyle(Theme.secondaryOnCard)
                .lineLimit(2)
            Spacer(minLength: Theme.Space.sm)
            Button("Show all", action: showAll)
                .buttonStyle(.walnut(.secondary, size: .small))
                .accessibilityIdentifier("inbox.filterOn.showAll")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox.filterOn")
    }
}

/// What an empty filter says. The inbox HAS letters in this case, just none
/// under this filter, so each line names the filter and what would appear here.
struct InboxEmptyCopy: Equatable {
    let title: String
    let detail: String
    let symbol: String

    init(filter: InboxFilter) {
        switch filter {
        case .all:
            title = "No letters yet"
            detail = "When an agent finishes something worth reading, or needs a decision, its letter shows up here."
            symbol = "envelope"
        case .unread:
            title = "No unread letters"
            detail = "You have read everything in your inbox."
            symbol = "envelope.open"
        case .actionNeeded:
            title = "No decisions waiting"
            detail = "A letter that asks you to decide shows up here until you open it."
            symbol = "hand.raised"
        case .review:
            title = "Nothing to review"
            detail = "Letters that ask you to look something over show up here."
            symbol = "doc.text.magnifyingglass"
        case .completion:
            title = "No completed work"
            detail = "Letters that report finished work show up here."
            symbol = "checkmark.seal"
        case .info:
            title = "No info letters"
            detail = "Letters that only keep you informed show up here."
            symbol = "info.circle"
        }
    }
}

/// One line above the list while a read the server did not take is waiting to
/// be sent again, so a row that went back to unread after being opened is
/// explained rather than looking like a glitch.
struct InboxReadRetryNotice: View {
    let count: Int

    static func text(count: Int) -> String {
        count == 1
            ? "1 letter could not be marked read yet. Walnut will try again."
            : "\(count) letters could not be marked read yet. Walnut will try again."
    }

    var body: some View {
        Label(Self.text(count: count), systemImage: "arrow.triangle.2.circlepath")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("inbox.readRetryNotice")
    }
}
