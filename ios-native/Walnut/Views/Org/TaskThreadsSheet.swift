import SwiftUI

/// A leader task's Threads (additive, 2026-11-18): the user's own requests to the task, one card
/// per subject, the same view Main and the VPs keep on their Org page (`OrgThreadsView`), opened
/// from the session menu once he turned Threads on there (`WalnutTask.threadsOn`, server
/// `src/core/org/keeps-threads.ts`). The web shows the same beside its chat
/// (`web/src/components/sessions/SessionThreadsPane.tsx`).
struct TaskThreadsSheet: View {
    let taskId: String
    let name: String
    /// The task's chat, for Follow up.
    let sessionId: String?
    /// Turns them off; true when the server took it (the sheet then closes).
    let turnOff: () async -> Bool

    @State private var store: OrgThreadsStore
    @State private var cover: OrgNodePageCover?
    @State private var revealedAt: Date?
    @State private var offFailed = false
    @State private var turningOff = false
    @Environment(\.dismiss) private var dismiss

    init(taskId: String, name: String, sessionId: String?, turnOff: @escaping () async -> Bool) {
        self.taskId = taskId
        self.name = name
        self.sessionId = sessionId
        self.turnOff = turnOff
        _store = State(initialValue: OrgThreadsStore(taskId: taskId))
    }

    var body: some View {
        NavigationStack {
            OrgThreadsView(store: store, name: name, sessionId: sessionId, revealedAt: $revealedAt, cover: $cover)
                .background(Color(uiColor: .systemGroupedBackground))
                .navigationTitle("Threads")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                            .accessibilityIdentifier("task.threads.done")
                    }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Turn Off") {
                            turningOff = true
                            Task {
                                let ok = await turnOff()
                                turningOff = false
                                offFailed = !ok
                                if ok { dismiss() }
                            }
                        }
                        .disabled(turningOff)
                        .accessibilityIdentifier("task.threads.off")
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    if offFailed {
                        Text("Did not save. Try again.")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .padding(8)
                            .accessibilityIdentifier("task.threads.offFailed")
                    }
                }
        }
        .task {
            await store.hydrate()
            await store.load()
        }
        // A failed read is tried again while the sheet is up, as the Org page does.
        .task(id: store.lastRead?.failed == true) {
            while store.lastRead?.failed == true, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(OrgThreadsStore.retrySeconds))
                guard !Task.isCancelled, store.lastRead?.failed == true else { return }
                if !store.loading { await store.load() }
            }
        }
        .sheet(item: $cover) { cover in
            coverView(cover)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task.threads.sheet")
    }

    @ViewBuilder
    private func coverView(_ cover: OrgNodePageCover) -> some View {
        switch cover {
        case .task(let target):
            TaskSessionSheet(target: target)
        }
    }
}
