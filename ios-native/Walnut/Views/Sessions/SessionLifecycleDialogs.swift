import SwiftUI

/// The session page's lifecycle prompts: Rename (PATCH title), Terminate's confirmation
/// (it stops the process at once and sits last in the menu), and the 409 cron_owner
/// ladder (confirm, then force-terminate). Kept out of SessionConversationView.body's
/// modifier chain, which is at the type checker's limit.
struct SessionLifecycleDialogs: ViewModifier {
    let lifecycle: SessionLifecycleController
    @Binding var showRename: Bool
    @Binding var renameDraft: String
    @Binding var confirmTerminate: Bool
    @Binding var forceTerminateMessage: String?

    func body(content: Content) -> some View {
        content
            // A plain alert keeps the rename lightweight.
            .alert("Rename Session", isPresented: $showRename) {
                TextField("Title", text: $renameDraft)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    let title = renameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    Task { await lifecycle.rename(title) }
                }
            }
            // An alert, not a confirmationDialog: iOS 26 draws a page-level dialog as a popover
            // whose arrow points at the middle of the page and drops its Cancel button.
            .alert("Terminate this session?", isPresented: $confirmTerminate) {
                Button("Terminate", role: .destructive) {
                    Task {
                        if case .needsForce(let message) = await lifecycle.terminate() {
                            forceTerminateMessage = message
                        }
                    }
                }
                .accessibilityIdentifier("session.terminate.confirm")
                Button("Cancel", role: .cancel) {}
                    .accessibilityIdentifier("session.terminate.cancel")
            } message: {
                Text("Its process stops now. The task and the conversation stay.")
            }
            .alert("Session owns scheduled routines", isPresented: Binding(
                get: { forceTerminateMessage != nil },
                set: { if !$0 { forceTerminateMessage = nil } }
            )) {
                Button("Cancel", role: .cancel) { forceTerminateMessage = nil }
                Button("Force Terminate", role: .destructive) {
                    forceTerminateMessage = nil
                    Task { _ = await lifecycle.terminate(force: true) }
                }
            } message: {
                Text(forceTerminateMessage ?? "")
            }
    }
}
