import SwiftUI

struct EmailItemsView: View {
    let letterId: String
    let items: [InboxEmailItem]
    var onOpenTask: (String, String?) -> Void = { _, _ in }
    private let store = InboxItemStore.shared
    private func card(_ item: InboxEmailItem) -> some View {
        let duplicate = items.contains { other in
            other.id != item.id && other.accountLabel == item.accountLabel && other.source?.account != item.source?.account
        }
        return EmailItemCard(letterId: letterId, item: item, duplicateAccount: duplicate, onOpenTask: onOpenTask)
    }
    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("Email items (\(items.count))").font(.body.weight(.semibold))
                Text("Mailbox counts in this summary are a snapshot, not live status.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    card(item)
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("inbox.items.\(items.first?.id ?? "empty")")
            .onAppear { store.seed(items, letterId: letterId) }
            .onChange(of: items) { _, value in store.seed(value, letterId: letterId) }
        }
    }
}
