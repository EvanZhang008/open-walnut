import SwiftUI

/// The session page's lifecycle prompts: Rename (PATCH title, a `DictatedTextPrompt`), Terminate's confirmation
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
            // A small sheet with Walnut's mic (an alert hosts none). Both answers end the draft; a
            // push that closed the sheet leaves it, so the next Rename opens on his words
            // (SessionConversationView fills it only when empty).
            .sheet(isPresented: $showRename) {
                DictatedTextPrompt(
                    title: "Rename Session", placeholder: "Title", text: $renameDraft,
                    surface: "session-rename:\(lifecycle.sessionId)", box: "session-rename",
                    confirmTitle: "Rename", identifier: "session.rename",
                    onCancel: {
                        renameDraft = ""
                        showRename = false
                    },
                    onConfirm: { title in
                        renameDraft = ""
                        showRename = false
                        Task { await lifecycle.rename(title) }
                    }
                )
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
                Text("This ends the session itself, not just the turn it is on. The task and the conversation stay, and a new message starts it again. To only stop what the agent is doing right now, use Stop instead.")
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
