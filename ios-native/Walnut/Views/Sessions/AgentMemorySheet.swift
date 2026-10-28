import SwiftUI

/// "Memory & Instructions" for the CEO or a VP, opened from the session menu after Task Details
/// (the web's ⋮ row of the same name, `web/src/components/org/AgentMemoryPanel.tsx`):
/// - Instructions: the user's own standing words (`org_instructions`). They ride the agent's
///   session prompt, so it reads an edit with its next message; nothing is woken for it.
/// - Its own MEMORY.md: what the agent keeps for itself. Folded and read only: the agent owns it.
struct AgentMemorySheet: View {
    let taskId: String
    let isMain: Bool

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()
    @State private var text = ""
    /// The words as the server last had them, so Save knows whether anything changed.
    @State private var saved = ""
    @State private var loading = true
    /// The task could not be read. Save stays off: saving over words we never saw would replace them.
    @State private var loadFailed = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var memory: AgentMemoryView?
    @State private var memoryError: String?
    @State private var memoryOpen = false

    private static let maxChars = 4000

    var body: some View {
        NavigationStack {
            Form {
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.danger)
                    }
                }
                Section {
                    if loading {
                        HStack {
                            ProgressView()
                            Text("Loading…").foregroundStyle(.secondary)
                        }
                    } else if loadFailed {
                        Button("Try again") { Task { await load() } }
                            .accessibilityIdentifier("agentMemory.retry")
                    } else {
                        TextField("What it owns, how it works, what to watch for", text: $text, axis: .vertical)
                            .lineLimit(4...14)
                            .accessibilityIdentifier("agentMemory.instructions")
                            .onChange(of: text) { _, now in
                                // The server counts UTF-16 units, as JavaScript's length does.
                                if now.utf16.count > Self.maxChars { text = Self.clipped(now) }
                            }
                    }
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("Your own standing words for \(isMain ? "the CEO" : "this VP"). It reads them with its next message.")
                }
                Section {
                    if let memoryError {
                        Text("Couldn't read it: \(memoryError)").font(.footnote).foregroundStyle(.secondary)
                    } else if let memory {
                        DisclosureGroup(isExpanded: $memoryOpen) {
                            if let refused = memory.memory?.refused {
                                Text("Its last write was refused: \(Self.kChars(refused.chars)) characters is over the limit.")
                                    .font(.footnote)
                                    .foregroundStyle(Theme.danger)
                            }
                            if let words = memory.memory?.text, !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text(words)
                                    .font(.footnote.monospaced())
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("agentMemory.memoryText")
                            } else {
                                Text("Empty: it has written nothing yet.").font(.footnote).foregroundStyle(.secondary)
                            }
                        } label: {
                            HStack {
                                Text("Its own MEMORY.md")
                                Spacer()
                                Text("\(Self.kChars(memory.chars)) of \(Self.kChars(memory.softLimit))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                        }
                        .accessibilityIdentifier("agentMemory.memory")
                    } else {
                        HStack {
                            ProgressView()
                            Text("Reading…").foregroundStyle(.secondary)
                        }
                    }
                } footer: {
                    Text("It writes this itself; read only here.")
                }
            }
            .navigationTitle("Memory & Instructions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(loading || loadFailed || trimmed == saved)
                            .accessibilityIdentifier("agentMemory.save")
                    }
                }
            }
            .interactiveDismissDisabled(saving || trimmed != saved)
            .task { await load() }
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The longest whole-character prefix of `s` within the server's limit in UTF-16 units.
    static func clipped(_ s: String) -> String {
        var units = 0
        var end = s.startIndex
        for ch in s {
            let n = ch.utf16.count
            if units + n > maxChars { break }
            units += n
            end = s.index(after: end)
        }
        return String(s[..<end])
    }

    static func kChars(_ n: Int) -> String {
        guard n >= 1000 else { return String(n) }
        let k = (Double(n) / 1000 * 10).rounded() / 10
        return k == k.rounded() ? "\(Int(k))k" : "\(k)k"
    }

    private func load() async {
        loading = true
        loadFailed = false
        errorMessage = nil
        memoryError = nil
        async let detail = api.taskDetail(id: taskId)
        async let mine = api.agentMemory(taskId: taskId)
        do {
            let current = try await detail.orgInstructions?.text ?? ""
            text = current
            saved = current
        } catch let error as APIError where error.isCancelled {
            loadFailed = true
        } catch {
            loadFailed = true
            errorMessage = "Couldn't load the instructions: \(SessionControlsSheet.friendlyControlError(error))"
        }
        loading = false
        do {
            memory = try await mine
        } catch {
            memoryError = SessionControlsSheet.friendlyControlError(error)
        }
    }

    private func save() async {
        guard !saving else { return }
        saving = true
        errorMessage = nil
        defer { saving = false }
        let words = trimmed
        do {
            try await api.setOrgInstructions(taskId: taskId, text: words)
            saved = words
            AppLog.info("session", "saved org instructions", ["taskId": taskId, "chars": String(words.count)])
            dismiss()
        } catch {
            errorMessage = "Couldn't save: \(SessionControlsSheet.friendlyControlError(error))"
        }
    }
}
