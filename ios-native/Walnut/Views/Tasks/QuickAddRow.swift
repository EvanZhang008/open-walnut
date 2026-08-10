import SwiftUI

/// Things/Todoist-style one-line quick add. Type "buy milk tomorrow 3pm",
/// hit return → the task appears INSTANTLY (raw text as title) and the AI
/// parse upgrades it in place seconds later (cleaned title, due date, pin,
/// project). The field keeps focus after each add for rapid multi-add.
///
/// `pinSeed` pre-pins created tasks (the pinned/focus section's + row).
/// The expand affordance opens the full NewTaskSheet prefilled with the
/// typed sentence — AI backfills there too, never blocks (standing rule:
/// every AI flow keeps a manual path).
struct QuickAddRow: View {
    var pinSeed = false
    /// accessibilityIdentifier prefix ("tasks.quickAdd" / "focus.quickAdd").
    var identifier = "tasks.quickAdd"
    /// Present the full form sheet, seeded with the current text.
    var onExpand: ((String) -> Void)? = nil

    @Environment(TasksStore.self) private var tasks

    @State private var text = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    private var placeholder: String {
        pinSeed ? "Pin a task…  \"ship the report friday\"" : "Add a task…  \"call mom tomorrow 5pm\""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: pinSeed ? "pin.circle.fill" : "plus.circle.fill")
                    .font(.body)
                    .foregroundStyle(Theme.tint)
                TextField(placeholder, text: $text)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    .accessibilityIdentifier("\(identifier).field")
                if let onExpand, !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    // Expand to the full form (project/priority/date pickers),
                    // carrying the sentence along.
                    Button {
                        onExpand(text)
                        text = ""
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("\(identifier).expand")
                }
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
        .accessibilityIdentifier(identifier)
    }

    /// Fire-and-forget create: the optimistic insert makes the row appear
    /// before the POST even resolves, so the field clears IMMEDIATELY and
    /// stays focused for the next one — no spinner, no modal, no wait.
    private func submit() {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        text = ""
        errorMessage = nil
        focused = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let seed = pinSeed
        Task {
            do {
                _ = try await tasks.quickAdd(raw, pinSeed: seed)
            } catch {
                // Create failed (offline / server error): restore the text so
                // nothing typed is lost, and say why.
                if text.isEmpty { text = raw }
                errorMessage = (error as? APIError)?.localizedDescription ?? error.localizedDescription
                focused = true
            }
        }
    }
}
