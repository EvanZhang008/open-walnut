import SwiftUI

/// A short question answered with a few words (a title, a name, a first message), in a small
/// sheet with Walnut's mic. It takes the place of an alert with a text field: an alert hosts no
/// mic, so every rename and first-message prompt asked here instead.
///
/// The words live in the presenter's state (`text`), never in the sheet: a push that closes the
/// sheet keeps them, and the same prompt opens on them again, as the alert did. The confirm button
/// waits for words still being spoken or transcribed (`DictationSendGate`); stopping the mic only
/// puts the words in the box, it never confirms.
struct DictatedTextPrompt: View {
    let title: String
    var message: String?
    let placeholder: String
    @Binding var text: String
    /// The box's stable key, e.g. "session-rename:<sessionId>": a take saved here comes back
    /// only into this prompt for this object.
    let surface: String
    /// Short name of the box: the mic is "voice-mic.<box>".
    let box: String
    let confirmTitle: String
    /// Prefix of the identifiers: "<identifier>.field", ".confirm" and ".cancel".
    let identifier: String
    /// A first message wraps over lines; a title stays on one, and Return confirms it.
    var multiline = false
    var autocorrect = true
    let onCancel: () -> Void
    /// The trimmed words, never empty. The presenter closes the sheet.
    let onConfirm: (String) -> Void

    @State private var sendGate = DictationSendGate()
    @FocusState private var focused: Bool

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VoiceDictationField(
                        text: $text, surface: surface, box: box, refocus: { focused = true }
                    ) {
                        TextField(placeholder, text: $text, axis: multiline ? .vertical : .horizontal)
                            .lineLimit(multiline ? 1...6 : 1...1)
                            .autocorrectionDisabled(!autocorrect)
                            .focused($focused)
                            .submitLabel(multiline ? .return : .done)
                            .onSubmit { if !multiline { confirm() } }
                            .accessibilityIdentifier("\(identifier).field")
                    }
                } footer: {
                    if let message { Text(message) }
                }
            }
            .dictationSendGate(sendGate)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        sendGate.cancelWait()
                        onCancel()
                    }
                    .accessibilityIdentifier("\(identifier).cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: confirm) {
                        DictationSendLabel(gate: sendGate, title: confirmTitle)
                    }
                    .fontWeight(.semibold)
                    // Live while words are being spoken in, even into an empty box.
                    .disabled(trimmed.isEmpty && !sendGate.isDictating && !sendGate.isWaiting)
                    .accessibilityIdentifier("\(identifier).confirm")
                }
            }
        }
        .presentationDetents([.medium, .large])
        // After the sheet's own appear, or the keyboard does not come up with it.
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { focused = true } }
    }

    private func confirm() {
        sendGate.send { _ in
            // Read again after a wait: the spoken words are in the box now.
            let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !words.isEmpty else { return }
            onConfirm(words)
        }
    }
}

// MARK: - One prompt's words per object

/// The words of a prompt asked about one object at a time (a first message for one chat), kept per
/// object in the app-wide draft store (`ComposerDrafts`, so they also outlive the app). The
/// binding names its object's key: the prompt for one chat never opens on another's words, and a
/// take that finishes after its prompt closed writes into its own object's draft, never into the
/// prompt that is up now.
@MainActor
enum PromptDraft {
    /// Drafts kept per family (the prefix), besides the one being written.
    static let kept = 10

    static func binding(_ key: String, prefix: String, store: ComposerDrafts = .shared) -> Binding<String> {
        Binding(get: { store.draft(key) }, set: { value in
            store.setDraft(value, key: key)
            store.trimDrafts(prefix: prefix, keeping: key, max: kept - 1)
        })
    }
}

/// Words for a prompt that opens on the object's current value (a rename opens on the title), one
/// entry per object. An entry stays until Cancel or the answer ends it, so a push that closed the
/// prompt opens it again on his words; a take that lands after its prompt closed writes only its
/// own object's entry. Pure, so it is unit-tested.
struct PromptDrafts: Equatable {
    private(set) var words: [String: String] = [:]

    /// Opening the prompt for `key`: on his words for it, else on `seed`.
    mutating func open(_ key: String, seed: String) {
        if words[key] == nil { words[key] = seed }
    }

    subscript(key: String) -> String {
        get { words[key] ?? "" }
        set { words[key] = newValue }
    }

    /// Cancel or the answer: the next open starts from the seed again.
    mutating func end(_ key: String) { words[key] = nil }
}
