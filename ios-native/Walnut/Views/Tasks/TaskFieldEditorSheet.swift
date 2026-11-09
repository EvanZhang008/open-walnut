import SwiftUI

/// One open edit of a task's description or note: which field, and the text it opens with.
struct TaskFieldEdit: Identifiable, Equatable {
    enum Field: Equatable { case description, note }

    let id = UUID()
    let field: Field
    let text: String

    var title: String { field == .description ? "Description" : "Note" }
    var identifier: String { field == .description ? "task.descriptionEditor" : "task.noteEditor" }
    var voiceBox: String { field == .description ? "task-description" : "task-note" }
}

/// The plain-text editor sheet for a task's description or note. TaskDetailSheet presents it
/// from its root: raised from inside the sheet's scroll content, a sheet is rebuilt when its
/// text field takes focus, so the first tap lost the keyboard (the project picker showed it).
///
/// Save is optimistic: the editor closes immediately, the readback text already shows the new
/// content, and a failure reverts it and shows the error line (never a blocked Save button).
struct TaskFieldEditorSheet: View {
    let edit: TaskFieldEdit
    let taskId: String
    let onSave: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var sendGate = DictationSendGate()

    init(edit: TaskFieldEdit, taskId: String, onSave: @escaping (String) -> Void) {
        self.edit = edit
        self.taskId = taskId
        self.onSave = onSave
        _text = State(initialValue: edit.text)
    }

    var body: some View {
        NavigationStack {
            // Walnut's mic under the editor: the text stays readable while the
            // person speaks, and the words land at its end, never saved by
            // themselves.
            VoiceDictationField(
                text: $text, surface: "\(edit.voiceBox):\(taskId)", box: edit.voiceBox, placement: .below
            ) {
                TextEditor(text: $text)
                    .font(.body)
                    .accessibilityIdentifier(edit.identifier)
            }
            .padding(8)
            .dictationSendGate(sendGate)
            .navigationTitle(edit.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        sendGate.cancelWait()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        sendGate.send { _ in
                            onSave(text)
                            dismiss()
                        }
                    } label: {
                        DictationSendLabel(gate: sendGate, title: "Save")
                    }
                    .fontWeight(.semibold)
                    .accessibilityIdentifier("\(edit.identifier).save")
                }
            }
        }
        .presentationDetents([.large])
        // His unsaved words, or words still being dictated into them, hold a push; an editor he
        // opened and did not change lets it through (2026-11-08 review, round 3: it held always).
        .holdsNavigation(text != edit.text || sendGate.isWaiting)
    }
}
