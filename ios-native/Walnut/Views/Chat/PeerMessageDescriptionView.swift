import SwiftUI

struct PeerMessageDescriptionView: View {
    let description: PeerMessageDescription
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: description.sender)
                .font(.caption2)
                .foregroundStyle(ReadableText.secondary)
                // At accessibility sizes a long sender wraps, as the title does, never cut.
                .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            Text(verbatim: description.title)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, TimelineMetrics.chipHPad)
        .padding(.vertical, TimelineMetrics.chipVPad)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, TimelineMetrics.hMargin)
        .padding(.vertical, TimelineMetrics.chipRowVMargin)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(description.accessibilityLabel)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier("chat.peerMessage")
    }
}
