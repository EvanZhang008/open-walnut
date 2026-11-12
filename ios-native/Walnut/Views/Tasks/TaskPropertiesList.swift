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
    /// Present the sheet's project picker. The sheet presents it from its root: a sheet raised
    /// from inside its scroll content is rebuilt when a text field in it takes focus.
    let openProjectPicker: () -> Void
    var onPinnedChange: (Bool) -> Void = { _ in }
    /// The task's link tags as the server names them (the detail read; nil until it lands).
    var links: [LinkTagView]? = nil
    /// The detail read has landed. Before it (or when it failed) nothing says which link files are
    /// gone, so no link-looking tag is drawn: a removed file's raw path never shows and no Tags
    /// row appears only to fold away. After it, `links == nil` means an older server.
    var linksReady = true

    @Environment(TasksStore.self) private var tasks
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        TaskPropertyCard {
            statusRow
            TaskPropertyDivider()
            boardRow
            TaskPropertyDivider()
            backgroundRow
            TaskPropertyDivider()
            priorityRow
            TaskPropertyDivider()
            projectRow
            TaskPropertyDivider()
            dueRow
            if let tags = task.tags.map({ TaskTagPills.visibleTags($0, links: links, ready: linksReady) }), !tags.isEmpty {
                TaskPropertyDivider()
                tagsRow(tags)
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
        tasks.selectedTier(for: task).map(TaskBoardPlacement.tier) ?? .notOnBoard
    }

    private var boardRow: some View {
        Menu {
            ForEach(TaskPropertyLogic.boardOptions(
                tierChoices: tasks.allTierChoices, current: placement
            )) { option in
                Button {
                    choose(option.tierId)
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
                label: "Pin",
                value: TaskPropertyLogic.boardValueText(placement, tierChoices: tasks.allTierChoices),
                icon: placement == .notOnBoard ? "pin.slash" : "pin.fill"
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.board")
    }

    /// A tapped tier: pin into it, move to it, or unpin when it is the checked one
    /// (`PinTierPolicy.writes`, run by the store in order, stopped at the first failure).
    private func choose(_ tier: String) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task {
            if let failure = await tasks.pickTier(tier, for: task, onPinnedChange: onPinnedChange) {
                reportError(failure)
            }
        }
    }

    // MARK: - Background

    /// Background (2026-11-11): long-running work kept in the board's Background section
    /// whatever its state. One menu item, the board menu's words; the sheet's optimistic
    /// `apply`, so the eye above goes off at once when it ends a watch (the server's rule).
    private var backgroundRow: some View {
        let inBackground = BoardBackgroundItem.inBackground(task)
        return Menu {
            Button {
                apply(.init(backgroundAt: inBackground ? "" : ISO8601DateFormatter().string(from: AppClock.now())))
            } label: {
                Label(BoardBackgroundItem.label(inBackground: inBackground),
                      systemImage: BoardBackgroundItem.systemImage)
            }
        } label: {
            TaskPropertyRowLabel(
                label: "Background",
                value: inBackground ? "On" : "Off",
                icon: inBackground ? BoardBackgroundItem.systemImage : nil
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.prop.background")
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
            openProjectPicker()
        } label: {
            TaskPropertyRowLabel(
                label: "Project",
                value: task.project.isEmpty ? NewTaskSeed.inboxHeader : AskProjectName.display(task.project),
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
    /// would promise an editor that does not exist. The pills follow the server's
    /// display rules (`TaskTagPills`), and a linked one opens its page.
    ///
    /// Label above the pills, never beside them: several pills wrap, and a wrapped
    /// block squeezed into the value half of a row reads as two half-columns.
    private func tagsRow(_ tags: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tags")
                .font(.body)
                .foregroundStyle(.primary)
            TaskTagPills(tags: tags, links: links ?? [])
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("task.prop.tags")
    }
}
