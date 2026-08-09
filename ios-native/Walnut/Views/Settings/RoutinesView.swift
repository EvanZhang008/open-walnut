import SwiftUI

/// Routines management — the phone mirror of the console's scheduled-routines
/// panel (Wave 2 /api/v1/routines). List with enable toggle, Run Now, and
/// delete; the schedule shows read-only (creation/editing stays on desktop —
/// the cron form is a desktop-grade surface).
///
/// Cloud replica: every call relays to the primary over the bridge, so the
/// standard failure ladder copy applies (needs_upgrade / bridge_offline).
struct RoutinesView: View {
    private let api = WalnutAPI()

    @State private var jobs: [RoutineJob] = []
    @State private var loaded = false
    @State private var loadError: String?
    @State private var actionError: String?
    /// Job ids with a toggle/run/delete in flight (row controls disable).
    @State private var busyIds = Set<String>()
    /// Transient "ran" confirmation per job id (checkmark flash on Run Now).
    @State private var ranIds = Set<String>()
    @State private var pendingDelete: RoutineJob?

    var body: some View {
        List {
            if let actionError {
                Section {
                    Label(actionError, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(Theme.danger)
                }
            }
            if !loaded {
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading routines…").foregroundStyle(.secondary)
                    }
                }
            } else if let loadError {
                Section {
                    VStack(spacing: 8) {
                        Text(loadError)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Retry") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Theme.tint)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
            } else if jobs.isEmpty {
                Section {
                    Text("No routines yet. Create them from the desktop console.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 24)
                }
            } else {
                Section {
                    ForEach(jobs) { job in
                        routineRow(job)
                    }
                } footer: {
                    Text("Schedules are edited on the desktop console; here you can enable, disable, run, or delete.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Routines")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("routines.list")
        .refreshable { await load() }
        .task { await load() }
        .confirmationDialog(
            "Delete \"\(pendingDelete?.name ?? "")\"?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Routine", role: .destructive) {
                if let job = pendingDelete { Task { await remove(job) } }
                pendingDelete = nil
            }
        } message: {
            Text("The schedule is removed permanently. This can't be undone.")
        }
    }

    // MARK: - Row

    @ViewBuilder
    private func routineRow(_ job: RoutineJob) -> some View {
        let busy = busyIds.contains(job.id)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(job.name)
                        .font(.body.weight(.medium))
                        .lineLimit(2)
                    HStack(spacing: 6) {
                        chip(job.schedule.display, icon: "clock")
                        if let executor = job.executor {
                            chip(executor.label, icon: nil)
                        }
                    }
                }
                Spacer()
                Toggle("", isOn: Binding(
                    get: { job.enabled },
                    set: { _ in Task { await toggle(job) } }
                ))
                .labelsHidden()
                .disabled(busy)
                .accessibilityIdentifier("routines.toggle.\(job.id)")
            }
            lastRunLine(job)
            HStack(spacing: 14) {
                Button {
                    Task { await runNow(job) }
                } label: {
                    if ranIds.contains(job.id) {
                        Label("Started", systemImage: "checkmark.circle.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.success)
                    } else {
                        Label("Run Now", systemImage: "play.circle")
                            .font(.caption.weight(.semibold))
                    }
                }
                .buttonStyle(.borderless)
                .disabled(busy)
                .accessibilityIdentifier("routines.run.\(job.id)")
                Button(role: .destructive) {
                    pendingDelete = job
                } label: {
                    Label("Delete", systemImage: "trash")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .disabled(busy)
                .accessibilityIdentifier("routines.delete.\(job.id)")
                if busy { ProgressView().controlSize(.small) }
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 2)
        .opacity(job.enabled ? 1 : 0.55)
        // No row-level accessibilityIdentifier: on a List row it collapses
        // the children into one accessibility element, hiding the per-control
        // ids (routines.toggle/run/delete.<id>) from automation (verified
        // with Maestro hierarchy 2026-08-09).
    }

    @ViewBuilder
    private func lastRunLine(_ job: RoutineJob) -> some View {
        if let state = job.state {
            HStack(spacing: 5) {
                if let status = state.lastStatus {
                    Image(systemName: status == "ok" ? "checkmark.circle.fill"
                          : status == "error" ? "xmark.circle.fill" : "minus.circle")
                        .font(.caption2)
                        .foregroundStyle(status == "ok" ? Theme.success
                                         : status == "error" ? Theme.danger : .secondary)
                }
                if let last = state.lastRunDate {
                    Text("Last run \(last.formatted(.relative(presentation: .named)))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Never run")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if job.enabled, let next = state.nextRunDate, next > Date() {
                    Text("· next \(next.formatted(.relative(presentation: .named)))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            if state.lastStatus == "error", let error = state.lastError {
                Text(error)
                    .font(.caption2)
                    .foregroundStyle(Theme.danger)
                    .lineLimit(2)
            }
        }
    }

    private func chip(_ text: String, icon: String?) -> some View {
        HStack(spacing: 3) {
            if let icon { Image(systemName: icon).font(.system(size: 9)) }
            Text(text).font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .foregroundStyle(.secondary)
    }

    // MARK: - Actions

    private func load() async {
        do {
            jobs = try await api.routines()
            loadError = nil
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            loadError = Self.friendlyError(error)
        }
        loaded = true
    }

    /// Optimistic flip + rollback; the server's returned job is adopted as truth.
    private func toggle(_ job: RoutineJob) async {
        guard !busyIds.contains(job.id) else { return }
        busyIds.insert(job.id)
        actionError = nil
        let original = jobs
        replace(job.id) { RoutineJob(
            id: $0.id, name: $0.name, description: $0.description,
            enabled: !$0.enabled, schedule: $0.schedule, executor: $0.executor, state: $0.state
        ) }
        defer { busyIds.remove(job.id) }
        do {
            let updated = try await api.toggleRoutine(id: job.id)
            replace(job.id) { _ in updated }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "toggled routine", ["routineId": job.id, "enabled": String(updated.enabled)])
        } catch {
            jobs = original
            actionError = Self.friendlyError(error)
        }
    }

    private func runNow(_ job: RoutineJob) async {
        guard !busyIds.contains(job.id) else { return }
        busyIds.insert(job.id)
        actionError = nil
        defer { busyIds.remove(job.id) }
        do {
            try await api.runRoutineNow(id: job.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "ran routine now", ["routineId": job.id])
            // Flash "Started", then refresh state (lastRunAt moves).
            ranIds.insert(job.id)
            Task {
                try? await Task.sleep(for: .seconds(3))
                ranIds.remove(job.id)
                await load()
            }
        } catch {
            actionError = Self.friendlyError(error)
        }
    }

    private func remove(_ job: RoutineJob) async {
        guard !busyIds.contains(job.id) else { return }
        busyIds.insert(job.id)
        actionError = nil
        let original = jobs
        jobs.removeAll { $0.id == job.id }
        defer { busyIds.remove(job.id) }
        do {
            try await api.deleteRoutine(id: job.id)
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("routines", "deleted routine", ["routineId": job.id])
        } catch {
            jobs = original
            actionError = Self.friendlyError(error)
        }
    }

    private func replace(_ id: String, _ transform: (RoutineJob) -> RoutineJob) {
        jobs = jobs.map { $0.id == id ? transform($0) : $0 }
    }

    /// Honest copy for the cloud-relay failure ladder (same as session controls).
    static func friendlyError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "session_control_needs_upgrade":
            return "Your primary box is upgrading for mobile routines — try again in a minute."
        case "bridge_offline":
            return "The primary box isn't reachable right now — try again when it reconnects."
        case "not_found":
            return "This routine no longer exists on the server."
        case "internal" where apiError.localizedDescription.contains("not running"):
            return "The routines engine is still starting — try again in a moment."
        default:
            return apiError.localizedDescription
        }
    }
}
