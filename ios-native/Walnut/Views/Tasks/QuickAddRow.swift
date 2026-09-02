import SwiftUI

/// Things/Todoist-style one-line quick add. Type "buy milk tomorrow 3pm",
/// hit return → the task appears INSTANTLY (raw text as title) and the AI
/// parse upgrades it in place seconds later (cleaned title, due date, pin,
/// project). The field keeps focus after each add for rapid multi-add.
///
/// WHAT BELONGS ON THIS ROW, and what does not. A quick add earns its name by
/// costing one gesture, so the row carries exactly the things that decide WHERE
/// the task goes and nothing that describes WHAT it is:
///
///  - Destination (project + pin tier) is on the row, because it is what the
///    user is already looking at. When the row lives under a group header the
///    destination is IMPLICIT (`seed`) and costs zero taps; the chip only shows
///    the target so it is never a silent guess, and re-targeting is one tap.
///  - Title, due date, priority, description stay in the full sheet. They are
///    per-task prose and pickers; putting them here would make the row a form,
///    and a five-tap quick add is not a quick add. The `slider.horizontal.3`
///    expand button carries the typed sentence into that sheet, so nothing
///    typed is lost when a task turns out to need the long version.
///  - The AI parse already fills due date / priority / project from the
///    sentence itself, which is the real answer to "the quick add is missing
///    fields": they are typed, not tapped.
///
/// The expand affordance opens the full NewTaskSheet prefilled with the
/// typed sentence AND the current destination — AI backfills there too, never
/// blocks (standing rule: every AI flow keeps a manual path).
struct QuickAddRow: View {
    /// Where a task typed here is filed. A group header's `+` passes its own
    /// group; the top-level row passes the empty seed (server default).
    var seed: NewTaskSeed = NewTaskSeed(project: "", pin: .unspecified)
    /// Show the destination chip. Off for the pinned section's row, whose
    /// header already says where it files (and where the tier can't change).
    var showsDestination = true
    /// accessibilityIdentifier prefix ("tasks.quickAdd" / "focus.quickAdd").
    var identifier = "tasks.quickAdd"
    /// Present the full form sheet, seeded with the current text + destination.
    var onExpand: ((String, NewTaskSeed) -> Void)? = nil
    /// Autofocus the field on appear — a header `+` opened this row, so the
    /// keyboard should already be up.
    var autoFocus = false
    /// Called when the row wants to go away (Return on an empty field, or the
    /// field blurred with nothing typed). Only header-opened rows are dismissible.
    var onDismiss: (() -> Void)? = nil

    @Environment(TasksStore.self) private var tasks

    @State private var text = ""
    @State private var errorMessage: String?
    /// User override of `seed`'s destination for this row (nil = use the seed).
    @State private var override: NewTaskSeed?
    @FocusState private var focused: Bool

    /// The destination in force right now.
    private var destination: NewTaskSeed { override ?? seed }

    private var placeholder: String {
        if case .tier(let id) = destination.pin {
            return "Add to \(tasks.tierLabel(for: id))…"
        }
        if !destination.project.isEmpty {
            return "Add to \(destination.project)…"
        }
        return "Add a task…  \"call mom tomorrow 5pm\""
    }

    private var leadingIcon: String {
        destination.pin.namesTier ? "pin.circle.fill" : "plus.circle.fill"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 10) {
                Image(systemName: leadingIcon)
                    .font(.body)
                    .foregroundStyle(Theme.tint)
                // Empty label + our own placeholder ink: the platform's is
                // `label` at 30% alpha, which measured 2.48:1 over this card in
                // dark mode and about 1.7:1 in light. This placeholder is not
                // decoration — it is the only thing that says where the task
                // will be filed — so it is held to the 4.5:1 text bar
                // (`FieldPlaceholder`).
                TextField("", text: $text)
                    .fieldPlaceholder(placeholder, showing: text.isEmpty)
                    .focused($focused)
                    .submitLabel(.done)
                    .onSubmit(submit)
                    .accessibilityIdentifier("\(identifier).field")
                if showsDestination {
                    destinationChip
                }
                if let onExpand, !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    // Expand to the full form (project/priority/date pickers),
                    // carrying the sentence AND the destination along.
                    Button {
                        onExpand(text, destination)
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
        .onAppear {
            guard autoFocus else { return }
            // Next runloop: the TextField must exist before focusing.
            DispatchQueue.main.async { focused = true }
        }
        .onChange(of: focused) { _, isFocused in
            // Blurred with nothing typed = the user changed their mind. Only
            // dismissible (header-opened) rows collapse; the persistent
            // top-level row just sits there like Reminders'.
            if !isFocused, text.trimmingCharacters(in: .whitespaces).isEmpty {
                onDismiss?()
            }
        }
        // Children stay individually addressable: a container identifier
        // overwrites every descendant's, and the field would become unreachable.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    /// One-tap destination picker: the tier set (plus "not pinned") and, when
    /// the row was opened from a project header, that project. A MENU rather
    /// than inline chips because the tier set is dynamic and the row has one
    /// line — the label always states the current target, so it is a
    /// confirmation as much as a control.
    private var destinationChip: some View {
        Menu {
            Section("Pin") {
                Button {
                    override = NewTaskSeed(project: destination.project, pin: .unspecified)
                } label: {
                    label("Default", checked: destination.pin == .unspecified)
                }
                Button {
                    override = NewTaskSeed(project: destination.project, pin: .notPinned)
                } label: {
                    label("Not pinned", checked: destination.pin == .notPinned)
                }
                ForEach(tasks.allTierChoices, id: \.id) { choice in
                    Button {
                        override = NewTaskSeed(project: destination.project, pin: .tier(choice.id))
                    } label: {
                        label(choice.label, checked: destination.pin == .tier(choice.id))
                    }
                }
            }
        } label: {
            HStack(spacing: 3) {
                Text(destinationLabel)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(destination.pin == .unspecified ? Color.secondary : Theme.tint)
            .background(
                destination.pin == .unspecified
                    ? AnyShapeStyle(.quaternary)
                    : AnyShapeStyle(Theme.tintSoft),
                in: Capsule()
            )
        }
        .accessibilityIdentifier("\(identifier).destination")
    }

    private var destinationLabel: String {
        switch destination.pin {
        case .tier(let id): return tasks.tierLabel(for: id)
        case .notPinned: return "No pin"
        case .unspecified: return destination.project.isEmpty ? "Pin" : destination.project
        }
    }

    @ViewBuilder
    private func label(_ text: String, checked: Bool) -> some View {
        if checked {
            Label(text, systemImage: "checkmark")
        } else {
            Text(text)
        }
    }

    /// Fire-and-forget create: the optimistic insert makes the row appear
    /// before the POST even resolves, so the field clears IMMEDIATELY and
    /// stays focused for the next one — no spinner, no modal, no wait.
    private func submit() {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Return on an empty field = done adding (Reminders behavior).
        guard !raw.isEmpty else { onDismiss?(); return }
        text = ""
        errorMessage = nil
        focused = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let target = destination
        Task {
            do {
                _ = try await tasks.quickAdd(raw, seed: target)
            } catch {
                // Create failed (offline / server error / a tier the box no
                // longer has): restore the text so nothing typed is lost, and
                // say why. A rejected tier is never silently downgraded.
                if text.isEmpty { text = raw }
                errorMessage = (error as? APIError)?.localizedDescription ?? error.localizedDescription
                focused = true
            }
        }
    }
}
