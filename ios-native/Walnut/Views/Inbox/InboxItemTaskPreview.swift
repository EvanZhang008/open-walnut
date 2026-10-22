import SwiftUI

struct InboxItemTaskPreview: View {
    let key: InboxItemStore.Key
    let candidate: InboxTaskCandidate
    var onOpenTask: (String, String?) -> Void
    private let store = InboxItemStore.shared
    @Environment(\.colorScheme) private var colorScheme
    @State private var detail: InboxTaskPreview?
    @State private var failed = false
    @State private var openedTask: InboxTaskDestination?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(InboxEmailItem.safe(detail?.title ?? candidate.title)).font(.body.weight(.semibold))
                Text("\((detail?.candidate ?? candidate).projectLabel) · \((detail?.candidate ?? candidate).phaseLabel)").font(.caption)
                if let detail {
                    Text("Work goal").font(.body.weight(.semibold))
                    Text(detail.description.flatMap { $0.isEmpty ? nil : $0 } ?? "No work goal recorded")
                        .font(.body).textSelection(.enabled)
                    Text("Recent activity").font(.body.weight(.semibold))
                    if let activity = detail.activity, !activity.isEmpty {
                        ForEach(Array(activity.enumerated()), id: \.offset) { _, row in
                            Text(InboxEmailItem.safe(row.text, limit: 4000)).font(.body)
                            Text(row.at ?? "Time unavailable").font(.caption)
                        }
                    } else { Text("Activity unavailable").font(.caption) }
                } else if failed {
                    Text("Could not load task preview")
                    Button("Try again") { Task { await load() } }.frame(minHeight: 44)
                } else { ProgressView("Loading task…") }
                DisclosureGroup("Task ID") { Text(candidate.id).font(.caption).textSelection(.enabled) }
                Button("Open task") { openedTask = InboxTaskDestination(id: candidate.id, title: detail?.title ?? candidate.title) }.frame(minHeight: 44)
                    .accessibilityHint("Opens this exact task without starting or changing it")
                    .accessibilityIdentifier("inbox.item.taskPreview.open")
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }.navigationTitle("Preview task").navigationBarTitleDisplayMode(.inline)
            .barPage(Color(uiColor: .systemBackground))
            .toolbarColorScheme(colorScheme, for: .navigationBar)
            .task(id: candidate.id) { await load() }
            .sheet(item: $openedTask) { destination in InboxItemReadOnlyTaskSheet(key: key, destination: destination).presentationDetents([.large]) }
    }
    private func load() async {
        failed = false
        do {
            let value = try await store.taskPreview(key, taskId: candidate.id)
            guard value.id == candidate.id else { failed = true; return }
            detail = value
        } catch { failed = true }
    }
}

/// Task selection stays read-only, including the detail sheet opened from a preview.
struct InboxItemReadOnlyTaskSheet: View {
    let key: InboxItemStore.Key
    let destination: InboxTaskDestination
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var detail: InboxTaskPreview?
    @State private var failed = false
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let detail {
                        Text(InboxEmailItem.safe(detail.title)).font(.body.weight(.semibold))
                        Text("\(detail.candidate.projectLabel) · \(detail.candidate.phaseLabel)").font(.caption)
                        Text("Work goal").font(.body.weight(.semibold))
                        Text(detail.description.flatMap { $0.isEmpty ? nil : $0 } ?? "No work goal recorded").textSelection(.enabled)
                        Text("Recent activity").font(.body.weight(.semibold))
                        if let rows = detail.activity, !rows.isEmpty {
                            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                                Text(InboxEmailItem.safe(row.text, limit: 4000)).textSelection(.enabled)
                                Text(row.at ?? "Time unavailable").font(.caption)
                            }
                        } else { Text("Activity unavailable").font(.caption) }
                        DisclosureGroup("Task ID") { Text(detail.id).textSelection(.enabled).font(.caption) }
                    } else if failed {
                        Text("Could not load task preview")
                        Button("Try again") { Task { await load() } }.frame(minHeight: 44)
                    } else { ProgressView("Loading task…") }
                }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            }.navigationTitle("Task details").navigationBarTitleDisplayMode(.inline)
                .barPage(Color(uiColor: .systemBackground))
                .toolbarColorScheme(colorScheme, for: .navigationBar)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .task { await load() }
        }
    }
    private func load() async {
        failed = false
        do {
            let value = try await InboxItemStore.shared.taskPreview(key, taskId: destination.id)
            guard value.id == destination.id else { failed = true; return }
            detail = value
        } catch { failed = true }
    }
}
