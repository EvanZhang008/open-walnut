import SwiftUI

/// The composer `+` menu's "Latest update": the session recap the turn-complete
/// self-report writes, Overall (the whole session) and Latest (the last turn).
/// The web drew it as a card above the composer until 2026-10-26, when the user
/// asked for it to live in the `+` menu instead; the phone never had the card,
/// so here it is a small sheet read from the page's detail poll.
struct SessionLatestUpdateSheet: View {
    let overall: String?
    let latest: String?
    /// When the text was written, so an old recap reads as old.
    var updatedAt: Date? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let updatedAt {
                        Text("Updated \(RelativeTime.short(date: updatedAt))")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("session.latestUpdate.updated")
                    }
                    if let overall {
                        row(label: "Overall", text: overall, id: "session.latestUpdate.overall")
                    }
                    if let latest {
                        row(label: "Latest", text: latest, id: "session.latestUpdate.latest")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle("Latest update")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("session.latestUpdate.done")
                }
            }
        }
        .accessibilityIdentifier("session.latestUpdate.sheet")
    }

    private func row(label: String, text: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(id)
    }
}
