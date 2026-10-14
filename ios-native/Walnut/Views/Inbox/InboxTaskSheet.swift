import SwiftUI

struct InboxTaskDestination: Identifiable {
    let id: String
    let title: String?
}

struct InboxTaskSheet: View {
    let destination: InboxTaskDestination
    @Environment(TasksStore.self) private var tasks
    @Environment(\.dismiss) private var dismiss
    @State private var detail: TaskDetail?
    @State private var errorText: String?
    @State private var loading = false

    private var task: WalnutTask? {
        detail.map { WalnutTask(detail: $0) }
    }

    var body: some View {
        Group {
            if let task {
                TaskDetailSheet(task: task, detail: detail)
                    .task {
                        if task.isUnread {
                            do { _ = try await tasks.updateTask(id: task.id, edit: .init(unread: false)) }
                            catch { AppLog.warn("inbox", "task read marker failed", ["taskId": task.id, "error": error.localizedDescription]) }
                        }
                    }
            } else {
                NavigationStack {
                    Group {
                        if let errorText {
                            ContentUnavailableView {
                                Label("Can't open this task", systemImage: "checklist")
                            } description: {
                                Text(errorText)
                            } actions: {
                                Button("Try Again") { Task { await load() } }
                                    .accessibilityIdentifier("inbox.task.retry")
                            }
                        } else {
                            ProgressView("Loading task…")
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    .navigationTitle(destination.title ?? "Task")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { dismiss() }
                        }
                    }
                }
            }
        }
        .task { if task == nil { await load() } }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        errorText = nil
        defer { loading = false }
        do {
            detail = try await WalnutAPI().taskDetail(id: destination.id)
        } catch {
            if let apiError = error as? APIError, apiError.isCancelled { return }
            errorText = TaskDetailSheet.friendlyEditError(error)
        }
    }
}
