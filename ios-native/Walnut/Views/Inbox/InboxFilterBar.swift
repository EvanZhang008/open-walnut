import SwiftUI

/// The Inbox filter row: All, Unread (count), Action needed (count), then one
/// chip per remaining letter type. A horizontal rail so every chip keeps its
/// full label at the largest text size instead of squeezing; the selected chip
/// is scrolled into view on appear, so a filter remembered from last launch is
/// never hidden off the edge.
///
/// Same visual language as the Tasks board's band chips (lit chip = tint fill,
/// the rest one opaque grey), so the app has one look for "filter this list".
struct InboxFilterBar: View {
    let selection: InboxFilter
    let count: (InboxFilter) -> Int?
    let onSelect: (InboxFilter) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(InboxFilter.allCases) { filter in
                        chip(filter).id(filter)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .onAppear { proxy.scrollTo(selection, anchor: .center) }
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
            HStack(spacing: 5) {
                Text(filter.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                if let value {
                    Text(value.formatted(.number))
                        .font(.caption2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(isSelected ? Theme.onTint : BoardBandBar.unselectedChipCount)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(minHeight: 30)
            .foregroundStyle(isSelected ? Theme.onTint : BoardBandBar.unselectedChipLabel)
            .background(
                isSelected ? AnyShapeStyle(Theme.tint) : AnyShapeStyle(BoardBandBar.unselectedChipFill),
                in: Capsule()
            )
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("inbox.filter.\(filter.rawValue)")
        // The visible words stay the label (a matcher or a person looking for
        // "Unread" must find it); the count rides as the value.
        .accessibilityLabel(filter.title)
        .accessibilityValue(value.map { "\($0)" } ?? "")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : [.isButton])
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
