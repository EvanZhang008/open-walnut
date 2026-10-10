import SwiftUI

/// "Talk to Walnut": a voice conversation with the Walnut agent, from the Chat tab.
///
/// The first thing said launches an ASK, the same task the Mac's Ask Walnut
/// creates (`POST /sessions { walnutAgent, voice }`), and the page becomes that
/// ask's session page with voice mode on. An ask and not the Chat tab's own
/// conversation, because the loop this is for ("hand it to the test task, tell
/// me when it is done") needs the agent's LATER turns: when a task it handed work
/// to finishes, the agent is woken and answers on its own, and the session page
/// streams and reads every turn, while the chat conversation only streams the
/// turns the phone starts.
struct VoiceAskPage: View {
    let agentID: String
    let agentName: String

    @Environment(\.dismiss) private var dismiss
    @Environment(TasksStore.self) private var tasks: TasksStore?
    @State private var voice: VoiceModeController?
    @State private var launched: WalnutSession?

    var body: some View {
        if let launched {
            SessionConversationView(session: launched, voiceModeOnOpen: .awaitingAnswer)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                            .accessibilityIdentifier("voiceAsk.close")
                    }
                }
        } else {
            draft
        }
    }

    private var draft: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "waveform")
                .font(.system(size: 44, weight: .semibold))
                .foregroundStyle(Theme.tint)
                .accessibilityHidden(true)
            Text("Talk to \(agentName)")
                .font(.title2.weight(.semibold))
            Text("Ask what is going on, or hand it something to do. It answers out loud, and tells you when the work it handed off is done.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .accessibilityIdentifier("voiceAsk.page")
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if let voice {
                VoiceModeBar(voice: voice, activity: nil, working: false, onExit: { dismiss() })
            }
        }
        .navigationTitle("Voice")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Close") { dismiss() }
                    .accessibilityIdentifier("voiceAsk.close")
            }
        }
        .task {
            guard voice == nil else { return }
            // No bubble exists before the launch, so the controller keeps unsent words.
            voice = VoiceModeController(sessionID: "ask-\(agentID)", rows: [], keepsUnsentText: true) { text in
                await launch(text)
            }
        }
        .onDisappear { voice?.shutDown() }
    }

    /// The spoken first message launches the ask. False keeps the page, and the
    /// controller keeps the words for Send again, so nothing said is lost.
    private func launch(_ text: String) async -> Bool {
        do {
            let created = try await WalnutAPI().launchVoiceAsk(agentID: agentID, message: text)
            // Before the swap: the session page paints this as its first bubble.
            SessionLaunchContext.stash(sessionId: created.sessionId, message: text)
            AppLog.info("voice-mode", "launched a voice ask", [
                "sessionId": created.sessionId, "taskId": created.taskId, "agentId": agentID,
            ])
            let now = ISO8601DateFormatter().string(from: Date())
            voice?.shutDown()
            launched = WalnutSession(
                id: created.sessionId, title: created.title, taskId: created.taskId,
                taskTitle: created.title, project: nil, host: "", processStatus: "idle",
                model: nil, mode: nil, startedAt: now, lastActiveAt: now, messageCount: 0,
                cwd: nil, pinned: nil, focusTier: nil, description: nil
            )
            if let tasks { Task { await tasks.loadSessions() } }
            return true
        } catch let APIError.server(_, code, message, _, _) {
            voice?.notice = code == "bad_request" && message.contains("cwd")
                ? "Your Mac needs a newer Walnut to start a voice conversation."
                : message
            return false
        } catch {
            voice?.notice = error.localizedDescription
            return false
        }
    }
}
