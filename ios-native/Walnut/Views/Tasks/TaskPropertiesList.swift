import SwiftUI

/// Every editable setting of a task, in one grouped list under the title.
///
/// Replaces the old chip row + the duplicate star/pin/tier button row at the
/// foot of the sheet. Two things this shape buys that chips did not: a setting
/// has exactly ONE home (pin and tier are one Board row, not a chip plus a
/// button), and the affordance is visible before the tap.
///
/// Writes stay optimistic exactly as before — `apply` runs the sheet's PATCH
/// path (store applies locally, PUT behind, revert + banner on failure), and the
/// pin/tier writes go through `TasksStore`, which is optimistic the same way.
struct TaskPropertiesList: View {
    let task: WalnutTask
    /// Phase line under Status, already filtered to "says something the status
    /// does not" by the sheet. nil hides it.
    let phaseCaption: String?
    /// The sheet's optimistic PATCH applier (owns haptics + the error banner).
    let apply: (TasksStore.TaskEdit) -> Void
    /// Put a focus-endpoint failure on the sheet's banner.
    let reportError: (String) -> Void
    /// Present the sheet's due picker.
    let openDuePicker: () -> Void

    @Environment(TasksStore.self) private var tasks
    @Environment(\.dynamicTypeSize) private var typeSize

    @State private var showProjectPicker = false

    var body: some View {
        TaskPropertyCard {
            statusRow
            TaskPropertyDivider()
            boardRow
            TaskPropertyDivider()
            priorityRow
            TaskPropertyDivider()
            projectRow
            TaskPropertyDivider()
            dueRow
            if let tags = task.tags, !tags.isEmpty {
                TaskPropertyDivider()
                tagsRow(tags)
            }
        }
        .sheet(isPresented: $showProjectPicker) {
            TaskProjectPicker(current: task.project) { picked in
                if picked != task.project { apply(.init(project: picked)) }
            }
        }
    }

    // MARK: - Status

    @ViewBuilder
    private var statusRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch TaskPropertyLogic.statusControl(for: typeSize) {
            case .segmented:
                Picker("Status", selection: statusSelection) {
                    ForEach(Array(TaskPropertyLogic.statusChoices.enumerated()), id: \.offset) { pair in
                        Text(pair.element.label).tag(pair.offset)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
            case .menu:
                // Three segments stop fitting long before the largest sizes, so
                // the row becomes the same label+value+menu every other row is.
                Menu {
                    statusMenuItems
                } label: {
                    TaskPropertyRowLabel(
                        label: "Status",
                        value: TaskPropertyLogic.statusLabel(task.status)
                    )
                }
                .buttonStyle(.plain)
            }
            if let phaseCaption {
                Text(phaseCaption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 10)
                    .accessibilityIdentifier("task.prop.phase")
            }
        }
        .accessibilityIdentifier("task.prop.status")
    }

    /// Bound to the segment INDEX, so a status the phone does not model reads as
    /// -1 (nothing selected) instead of silently claiming to be "To do".
    private var statusSelection: Binding<Int> {
        Binding(
            get: { TaskPropertyLogic.statusIndex(task.status) },
            set: { index in
                guard let next = TaskPropertyLogic.status(atIndex: index), next != task.status else { return }
                apply(.init(status: next))
            }
        )
    }

    @ViewBuilder
    private var statusMenuItems: some View {
        ForEach(TaskPropertyLogic.statusChoices, id: \.value) { choice in
            Button {
                guard choice.value != task.status else { return }
                apply(.init(status: choice.value))
            } label: {
                if choice.value == task.status {
                    Label(choice.label, systemImage: "checkmark")
                } else {
                    Text(choice.label)
                }
            }
        }
    }

    // MARK: - Board (pin + tier as one control)

    private var placement: TaskBoardPlacement {
        TaskPropertyLogic.placement(pinned: task.pinned == true, tierId: tasks.tierId(for: task.id))
    }

    private var boardRow: some View {
        Menu {
            ForEach(TaskPropertyLogic.boardOptions(
                tierChoices: tasks.allTierChoices, current: placement
            )) { option in
                Button {
                    choose(option.placement)
                } label: {
                    if option.isCurrent {
                        Label(option.label, systemImage: "checkmark")
                    } else {
                        Label(option.label, systemImage: option.icon)
                    }
                }
            }
        } label: {
            TaskPropertyRowLabel(
                label: "Board",
                value: TaskPropertyLogic.boardValueText(placement, tierChoices: tasks.allTierChoices),
                icon: placement == .notOnBoard ? "pin.slash" : "pin.fill"
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.board")
    }

    /// Run the writes the choice implies, in order, stopping at the first
    /// failure (a tier PUT after a failed pin would 400 for the wrong reason).
    private func choose(_ target: TaskBoardPlacement) {
        let writes = TaskPropertyLogic.writes(for: target, current: placement)
        guard !writes.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            for write in writes {
                switch write {
                case .pin, .unpin:
                    if let failure = await tasks.setPinned(task, pinned: write == .pin) {
                        reportError(failure)
                        return
                    }
                case .setTier(let tier):
                    if let failure = await tasks.setTier(taskId: task.id, tier: tier) {
                        reportError(failure)
                        return
                    }
                }
            }
        }
    }

    // MARK: - Priority

    private var priorityRow: some View {
        Menu {
            ForEach(TaskPropertyLogic.priorityChoices, id: \.value) { choice in
                Button {
                    guard choice.value != task.priority else { return }
                    apply(.init(priority: choice.value))
                } label: {
                    if choice.value == task.priority {
                        Label(choice.label, systemImage: "checkmark")
                    } else {
                        Text(choice.label)
                    }
                }
            }
        } label: {
            TaskPropertyRowLabel(
                label: "Priority",
                value: TaskPropertyLogic.priorityLabel(task.priorityKind),
                icon: TaskPropertyLogic.priorityIcon(task.priorityKind),
                tint: TaskPropertyLogic.priorityColor(task.priorityKind)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.priority")
    }

    // MARK: - Project / Due / Tags

    private var projectRow: some View {
        Button {
            showProjectPicker = true
        } label: {
            TaskPropertyRowLabel(
                label: "Project",
                value: task.project.isEmpty ? NewTaskSeed.inboxHeader : task.project,
                icon: task.project.isEmpty ? "tray" : "folder",
                affordance: .disclosure
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.project")
    }

    private var dueRow: some View {
        Button {
            openDuePicker()
        } label: {
            TaskPropertyRowLabel(
                label: "Due",
                value: TaskPropertyLogic.dueValueText(task.dueDateValue),
                icon: task.dueDate == nil ? nil : "calendar",
                tint: task.isOverdue ? Theme.danger : Theme.tint,
                affordance: .disclosure
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.due")
    }

    /// Read-only on purpose: nothing in the app writes tags, so a chevron here
    /// would promise an editor that does not exist.
    private func tagsRow(_ tags: [String]) -> some View {
        TaskPropertyRowLabel(
            label: "Tags",
            value: tags.joined(separator: ", "),
            affordance: .readOnly
        )
        .accessibilityIdentifier("task.prop.tags")
    }
}
