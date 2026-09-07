import SwiftUI

/// Wave-1 detail sections for TaskDetailSheet — description/note readback with
/// editing, blocked/children/parent relations, and the sheet's one destructive
/// Delete row. Split out of TaskDetailSheet to keep both files under the size
/// budget.
///
/// Star and pin used to live here too, as a second home for settings the chip
/// row above already owned. They are gone: pin is the Board row of
/// `TaskPropertiesList`, and `starred` is retired server-side (POST
/// /tasks/:id/star is a documented no-op that always answers `starred: false`),
/// so a star control could never latch and had to stop pretending it could.
struct TaskDetailExtras: View {
    @Bindable var controller: TaskDetailController
    /// Called after a successful delete — the sheet dismisses.
    var onDeleted: () -> Void

    @Environment(TasksStore.self) private var tasks

    @State private var editingDescription = false
    @State private var descriptionDraft = ""
    @State private var editingNote = false
    @State private var noteDraft = ""
    @State private var confirmDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let error = controller.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
            if let detail = controller.detail {
                relationsBlock(detail)
                descriptionBlock(detail)
                noteBlock(detail)
            } else if controller.loading {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading details…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            deleteRow
        }
        // Delete ladder: plain confirm first; 409 active-sessions → force.
        // Optimistic: the row vanishes + the sheet closes the moment the user
        // confirms; a failure reverts the row and surfaces on the list's
        // toast (a modal after dismissal would be homeless). A 409 marks the
        // id in deleteNeedsForceIds, so the NEXT delete confirm on this task
        // offers Stop Sessions & Delete directly.
        //
        // An ALERT, not a confirmationDialog, and BOTH rungs of the ladder are
        // alerts for the same reason. Presented from inside a sheet, iOS
        // anchored the confirmationDialog as a popover, and because the only
        // button in it was Delete, that button landed exactly where an action
        // sheet puts Cancel — a reflexive cancel tap deleted the task
        // (2026-09-07 UI gate). An alert is never anchored to the tap, and the
        // explicit `.cancel` button below is what guarantees a safe way out
        // exists no matter which rung is showing.
        .alert("Delete this task?", isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) { confirmDelete = false }
            if tasks.deleteNeedsForceIds.contains(controller.taskId) {
                Button("Stop Sessions & Delete", role: .destructive) {
                    deleteOptimistically(force: true)
                }
            } else {
                Button("Delete", role: .destructive) {
                    deleteOptimistically(force: false)
                }
            }
        } message: {
            Text("This can't be undone.")
        }
        .alert("Task has active sessions", isPresented: Binding(
            get: { controller.deleteNeedsForce != nil },
            set: { if !$0 { controller.deleteNeedsForce = nil } }
        )) {
            Button("Cancel", role: .cancel) { controller.deleteNeedsForce = nil }
            Button("Stop Sessions & Delete", role: .destructive) {
                controller.deleteNeedsForce = nil
                deleteOptimistically(force: true)
            }
        } message: {
            Text(controller.deleteNeedsForce?.first ?? "")
        }
        .sheet(isPresented: $editingDescription) {
            fieldEditor(
                title: "Description", text: $descriptionDraft,
                identifier: "task.descriptionEditor"
            ) { content in
                controller.saveDescription(content)
            }
        }
        .sheet(isPresented: $editingNote) {
            fieldEditor(title: "Note", text: $noteDraft, identifier: "task.noteEditor") { content in
                controller.saveNote(content)
            }
        }
    }

    // MARK: - Delete (the sheet's one destructive control, at the very bottom)

    private var deleteRow: some View {
        Button {
            confirmDelete = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "trash")
                    .font(.body)
                Text("Delete Task")
                    .font(.body)
                Spacer()
            }
            .foregroundStyle(Theme.danger)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(.secondarySystemGroupedBackground),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Theme.danger.opacity(0.35), lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(controller.acting)
        .accessibilityIdentifier("task.delete")
    }

    /// Live list row (the optimistic writes land here first).
    private var taskRow: WalnutTask? {
        tasks.tasks.first(where: { $0.id == controller.taskId })
    }

    /// Optimistic delete: dismiss + remove NOW; revert + toast on failure.
    /// Rows outside the list projection fall back to the awaited controller
    /// path (there is no local row to remove optimistically).
    private func deleteOptimistically(force: Bool) {
        guard taskRow != nil else {
            Task { if await controller.delete(force: force) { onDeleted() } }
            return
        }
        let taskId = controller.taskId
        onDeleted() // close the sheet immediately — the row is already gone
        Task {
            if let failure = await tasks.deleteTask(id: taskId, force: force) {
                // Row restored by the store; explain on the toast surface.
                tasks.transientError = failure
            }
        }
    }

    // MARK: - Relations (blocked / parent / children)

    @ViewBuilder
    private func relationsBlock(_ detail: TaskDetail) -> some View {
        if detail.isBlocked == true, let deps = detail.resolvedDependencies, !deps.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Label("Blocked by", systemImage: "hand.raised.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.warning)
                ForEach(deps) { dep in
                    relativeRow(dep)
                }
            }
        }
        if let parent = detail.parent {
            VStack(alignment: .leading, spacing: 6) {
                sectionHeader("Parent")
                relativeRow(parent)
            }
        }
        if let children = detail.children, !children.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                sectionHeader("Subtasks")
                ForEach(children) { child in
                    relativeRow(child)
                }
            }
        }
    }

    private func relativeRow(_ relative: TaskDetail.Relative) -> some View {
        HStack(spacing: 8) {
            Image(systemName: relative.phase == "COMPLETE" || relative.status == "done"
                ? "checkmark.circle.fill" : "circle")
                .font(.caption)
                .foregroundStyle(relative.phase == "COMPLETE" || relative.status == "done"
                    ? Theme.success : .secondary)
            Text(relative.title)
                .font(.subheadline)
                .lineLimit(1)
            Spacer()
            if let phase = relative.phase {
                Text(Self.phaseLabel(phase))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Description / note readback + editing

    @ViewBuilder
    private func descriptionBlock(_ detail: TaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                sectionHeader("Description")
                Spacer()
                Button {
                    descriptionDraft = detail.description ?? ""
                    editingDescription = true
                } label: {
                    Text(detail.description?.isEmpty == false ? "Edit" : "Add")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.tint)
                }
                .accessibilityIdentifier("task.editDescription")
            }
            if let description = detail.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            } else {
                Text("No description")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    @ViewBuilder
    private func noteBlock(_ detail: TaskDetail) -> some View {
        if let note = detail.note, !note.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    sectionHeader("Note")
                    Spacer()
                    Button {
                        noteDraft = note
                        editingNote = true
                    } label: {
                        Text("Edit")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Theme.tint)
                    }
                    .accessibilityIdentifier("task.editNote")
                }
                // The living document can be LONG (work logs) — plain text,
                // clipped with expand-on-tap, so the sheet never pays a full
                // markdown parse + layout for a 50KB note on open.
                CollapsibleText(text: note, collapsedLines: 12)
            }
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
    }

    /// Shared plain-text editor sheet for description/note. Save is
    /// optimistic: the editor closes immediately, the readback text already
    /// shows the new content, and a failure reverts it + shows the error line
    /// (never a blocked Save button).
    private func fieldEditor(
        title: String, text: Binding<String>, identifier: String,
        onSave: @escaping (String) -> Void
    ) -> some View {
        NavigationStack {
            TextEditor(text: text)
                .font(.body)
                .padding(8)
                .accessibilityIdentifier(identifier)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Cancel") {
                            editingDescription = false
                            editingNote = false
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Save") {
                            onSave(text.wrappedValue)
                            editingDescription = false
                            editingNote = false
                        }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("\(identifier).save")
                    }
                }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled()
    }

    /// Phase enum → readable Title Case.
    static func phaseLabel(_ phase: String) -> String {
        phase.split(separator: "_")
            .map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }
            .joined(separator: " ")
    }
}

/// Plain-text block clipped to N lines with an expand toggle. Cheap by
/// construction: SwiftUI lays out only the clipped window while collapsed.
struct CollapsibleText: View {
    let text: String
    let collapsedLines: Int

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(expanded ? nil : collapsedLines)
                .textSelection(.enabled)
            // Heuristic: only offer the toggle when clipping is plausible.
            if text.count > collapsedLines * 40 {
                Button(expanded ? "Show less" : "Show more") {
                    withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
                }
                .font(.caption.weight(.medium))
                .foregroundStyle(Theme.tint)
            }
        }
    }
}
