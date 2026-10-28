import SwiftUI

/// "Memory & Instructions" for the CEO or a VP, opened from the session menu after Task Details
/// (the web's ⋮ row of the same name, `web/src/components/org/AgentMemoryPanel.tsx`):
/// - Core instructions: the user's own (`org_instructions`), else Walnut's default for the role
///   (`GET /org/settings` `defaultInstructions`), which the box opens on. They ride the agent's
///   session prompt, so it reads an edit with its next message; nothing is woken for it. Saved
///   emptied or as the default's own words, the role follows the default again.
/// - Its own MEMORY.md: what the agent keeps for itself. Folded and read only: the agent owns it.
struct AgentMemorySheet: View {
    let taskId: String
    let isMain: Bool

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()
    @State private var text = ""
    /// The words the agent reads, as the server last had them, so Save knows whether anything changed.
    @State private var saved = ""
    /// Walnut's default for the role; "" from a server older than it.
    @State private var fallback = ""
    @State private var loading = true
    /// The task could not be read. Save stays off: saving over words we never saw would replace them.
    @State private var loadFailed = false
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var memory: AgentMemoryView?
    @State private var memoryError: String?
    @State private var memoryOpen = false
    /// Who wrote the stored words (the user or an agent), for the header's source line.
    @State private var stored: OrgInstructions?
    @State private var confirmDiscard = false

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
                            .disabled(saving)
                            .accessibilityIdentifier("agentMemory.instructions")
                    }
                    if !loading, !loadFailed, !fallback.isEmpty, !followsDefault {
                        Button("Restore Walnut's Default") { text = fallback }
                            .disabled(saving)
                            .accessibilityIdentifier("agentMemory.restoreDefault")
                    }
                } header: {
                    // Side by side while both fit; stacked when a long writer name or a large text
                    // size would break the title inside a word.
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 6) {
                            Text("Instructions").fixedSize()
                            sourceLabel
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Instructions")
                            sourceLabel
                        }
                    }
                } footer: {
                    if !loading, !loadFailed {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(footerText)
                            Text(countText)
                                .monospacedDigit()
                                .foregroundStyle(overLimit ? Theme.danger : .secondary)
                                .accessibilityIdentifier("agentMemory.count")
                        }
                    }
                }
                Section {
                    if let memoryError {
                        Text("Couldn't read its MEMORY.md: \(memoryError)").font(.footnote).foregroundStyle(.secondary)
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
                            // Side by side while both fit; stacked at the largest text sizes.
                            ViewThatFits(in: .horizontal) {
                                HStack {
                                    Text("Its own MEMORY.md").fixedSize()
                                    Spacer()
                                    memoryCount(memory)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Its own MEMORY.md")
                                    memoryCount(memory)
                                }
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
            // The session menu's name for it, so the two read the same.
            .navigationTitle("Core Instructions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // Unsaved words are asked about, never dropped silently.
                    Button("Cancel") { if dirty && !loading && !loadFailed { confirmDiscard = true } else { dismiss() } }
                        .disabled(saving)
                        .accessibilityIdentifier("agentMemory.cancel")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold)
                            .disabled(loading || loadFailed || !dirty || overLimit)
                            .accessibilityIdentifier("agentMemory.save")
                    }
                }
            }
            // Only typed words hold the sheet: never while it loads or after a failed read.
            .interactiveDismissDisabled(saving || (!loading && !loadFailed && dirty))
            .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard Changes", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            }
            .task { await load() }
        }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    /// What the agent would read with these words: an empty box is the default.
    private var reads: String { Self.reads(trimmed, fallback: fallback) }
    private var followsDefault: Bool { trimmed.isEmpty || Self.normalized(trimmed) == Self.normalized(fallback) }
    private var dirty: Bool { Self.dirty(text: text, saved: saved, fallback: fallback) }
    /// Words past the server's limit (UTF-16 units, as JavaScript counts): typed, pasted, or written
    /// before the server kept an agent's lines within it. Shown whole and never cut, since rewriting
    /// the box under the keyboard would end a composition and move the cursor; Save waits until
    /// they are shortened, as the server would refuse them.
    private var overLimit: Bool { Self.overLimit(text) }

    private var countText: String {
        let n = text.utf16.count
        if n > Self.maxChars { return "\(n - Self.maxChars) characters over the limit of \(Self.maxChars): shorten it to save." }
        return "\(n) of \(Self.maxChars) characters"
    }

    @ViewBuilder private var sourceLabel: some View {
        if !fallback.isEmpty, !loading, !loadFailed {
            // The header's own grey: a second secondary on top of it fades it out.
            Text(sourceText)
                .textCase(nil)
                .accessibilityIdentifier("agentMemory.instructionsSource")
        }
    }

    /// Whether Save has anything to send. Following the default before and after (a respaced copy
    /// of it, say) is no change.
    static func dirty(text: String, saved: String, fallback: String) -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let follows = words.isEmpty || normalized(words) == normalized(fallback)
        let savedFollows = !fallback.isEmpty && normalized(saved) == normalized(fallback)
        return !(follows && savedFollows) && reads(words, fallback: fallback) != saved
    }

    private func memoryCount(_ memory: AgentMemoryView) -> some View {
        Text("\(Self.kChars(memory.chars)) of \(Self.kChars(memory.softLimit))")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .monospacedDigit()
    }

    /// Where the words in the box come from, as the web's form says it: Walnut's default, words not
    /// saved yet ("Yours"), or who wrote the stored ones (the user, or an agent by its name).
    private var sourceText: String {
        Self.source(followsDefault: followsDefault, edited: reads != saved, stored: stored)
    }

    static func source(followsDefault: Bool, edited: Bool, stored: OrgInstructions?) -> String {
        if followsDefault { return "Walnut's default" }
        guard !edited, let stored, !stored.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return "Yours" }
        if stored.byUser { return "Yours" }
        return stored.usersWords ? "By \(stored.author) for you" : "Default and lines by \(stored.author)"
    }

    /// What the box opens on: what the agent reads. The user's words (or words written for them);
    /// Walnut's default followed by an agent's lines, so fixing one of them keeps the default; or the
    /// default alone. The web's `orgInstructionsShown` (src/core/org/core-instructions.ts).
    static func shown(_ stored: OrgInstructions?, fallback: String) -> String {
        let words = (stored?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let def = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        if words.isEmpty { return def }
        guard let stored, !stored.usersWords, !def.isEmpty else { return words }
        return "\(def)\n\n\(words)"
    }

    private var footerText: String {
        let who = isMain ? "the CEO" : "this VP"
        if fallback.isEmpty { return "Your own standing words for \(who). It reads them with its next message." }
        if trimmed.isEmpty { return "Empty: Walnut's default applies. It reads an edit with its next message." }
        if followsDefault {
            return "What \(who) is told in every session: Walnut's default until you write your own. It reads an edit with its next message."
        }
        return "What \(who) is told in every session. Restore Walnut's default to follow it again. It reads an edit with its next message."
    }

    static func reads(_ words: String, fallback: String) -> String {
        let w = words.trimmingCharacters(in: .whitespacesAndNewlines)
        return w.isEmpty ? fallback.trimmingCharacters(in: .whitespacesAndNewlines) : w
    }

    /// Whitespace aside, as the server compares a text to the default.
    static func normalized(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    static func overLimit(_ text: String) -> Bool { text.utf16.count > maxChars }

    /// What Save sends: "" when the box follows the default (empty, or the default's own words with
    /// whitespace aside), so the role keeps following it; else the box's words.
    static func outgoing(_ text: String, fallback: String) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty || normalized(words) == normalized(fallback) ? "" : words
    }

    /// The role's default from `GET /org/settings`: the CEO's for Main, a VP's otherwise; "" from a
    /// server older than the defaults.
    static func fallback(_ defaults: OrgSettingsView.Defaults?, isMain: Bool) -> String {
        (isMain ? defaults?.main : defaults?.lead) ?? ""
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
        async let settings = api.orgSettings()
        do {
            // A server older than the defaults answers without them, and the box holds the user's
            // words alone. A failed read is no answer: without the default in the box, a save would
            // turn an agent's lines into the user's own and drop the default.
            fallback = Self.fallback((try await settings).defaultInstructions, isMain: isMain)
            let row = try await detail.orgInstructions
            stored = row
            let shown = Self.shown(row, fallback: fallback)
            text = shown
            saved = shown
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
        // End editing before the field is disabled, so a composition or dictation is committed
        // before the words are read (as a letter's note does).
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        saving = true
        errorMessage = nil
        defer { saving = false }
        try? await Task.sleep(for: .milliseconds(150))
        // The committed words ran past the limit (the footer says so), or ending the input put the
        // box back to what it opened on: nothing is sent.
        guard dirty, !overLimit else { return }
        // The default's own words are no words of the user's: the role keeps following it.
        let words = Self.outgoing(text, fallback: fallback)
        do {
            try await api.setOrgInstructions(taskId: taskId, text: words)
            saved = reads
            stored = OrgInstructions(text: words, at: nil, by: "human")
            AppLog.info("session", "saved org instructions", ["taskId": taskId, "chars": String(words.count)])
            dismiss()
        } catch {
            errorMessage = "Couldn't save: \(SessionControlsSheet.friendlyControlError(error))"
        }
    }
}
