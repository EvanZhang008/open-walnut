import SwiftUI

/// A message the session received, as one step row like every other step of a turn
/// (the web's design 1): its icon, who sent it, its title in grey, one line. At an
/// accessibility size the title takes its own line under the sender, each one line,
/// the shape `TimelineRowBuilder.peerMessageRow` measured. Nothing to open: it reads.
struct PeerMessageDescriptionView: View {
    let description: PeerMessageDescription
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        TimelineChipRow(identifier: "chat.peerMessage", label: description.accessibilityLabel) {
            Image(systemName: Self.symbol(description)).font(.caption2)
        } content: {
            if TimelineChipLayout.stacksDetail(typeSize) {
                VStack(alignment: .leading, spacing: TimelineMetrics.chipStackSpacing) {
                    sender
                    title
                }
            } else {
                sender.layoutPriority(1)
                title
            }
        }
    }

    private var sender: some View {
        Text(verbatim: description.sender)
            .font(.caption.weight(.medium))
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private var title: some View {
        Text(verbatim: description.title)
            .font(.caption)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    /// Walnut's own notices ring a bell, a routine's fire is a bolt, anything else is
    /// a message received (the web's `envelopeStepIcon`, by the sender the line names).
    static func symbol(_ description: PeerMessageDescription) -> String {
        switch description.sender {
        case "Walnut", "System": return "bell"
        case "Routine": return "bolt"
        default:
            return description.sender.hasPrefix("Trigger") ? "bolt" : "tray.and.arrow.down"
        }
    }
}
