import SwiftUI

/// Session controls — model switch, reasoning effort, and fork — over the
/// additive /api/v1 session-control endpoints. Presented from the conversation
/// page's toolbar. Cloud-relay failures surface as honest, actionable copy
/// (same ladder as NewSessionSheet).
struct SessionControlsSheet: View {
    let session: WalnutSession
    /// Called with the pre-seeded fork session right before dismissal — the
    /// presenter pushes its conversation page.
    var onForked: (WalnutSession) -> Void

    @Environment(\.dismiss) private var dismiss
    private let api = WalnutAPI()

    @State private var options: SessionModelOptions?
    @State private var loadError: String?
    @State private var applying = false
    @State private var errorMessage: String?
    /// Read-back confirmation after a successful switch ("Applied live", …).
    @State private var confirmation: String?

    /// Wave-2 provider-neutral controls (mode select for Claude; native set
    /// for Codex/ACP). Best-effort: an old server just hides the section.
    @State private var controls: SessionControlsPayload?

    // Fork
    @State private var forkMessage = ""
    @State private var forking = false

    /// The catalog row matching the CURRENT model (drives the effort section).
    private var currentModel: SessionModelOptions.Model? {
        guard let options else { return nil }
        return options.models.first { $0.id == options.current }
    }

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
                if let confirmation {
                    Section {
                        Label(confirmation, systemImage: "checkmark.circle.fill")
                            .font(.subheadline)
                            .foregroundStyle(Theme.success)
                    }
                }
                modelSection
                effortSection
                providerControlsSection
                forkSection
            }
            .navigationTitle("Session Controls")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.disabled(forking)
                }
            }
            .task { await loadOptions() }
            .interactiveDismissDisabled(forking)
        }
    }

    // MARK: - Load

    private func loadOptions() async {
        loadError = nil
        do {
            options = try await api.sessionModelOptions(id: session.id)
        } catch let error as APIError where error.isCancelled {
            return
        } catch {
            options = nil
            loadError = Self.friendlyControlError(error)
        }
        // Wave-2 controls are additive: a 404 from an older server (or a 409
        // from an unattached Codex session) just hides the section.
        controls = try? await api.sessionControls(id: session.id)
    }

    // MARK: - Model

    @ViewBuilder
    private var modelSection: some View {
        Section {
            if let options {
                ForEach(options.models) { model in
                    Button {
                        Task { await switchModel(model) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(model.label)
                                    .foregroundStyle(.primary)
                                if model.supportsEffort == true {
                                    Text("Supports reasoning effort")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            Spacer()
                            if applying && pendingModelId == model.id {
                                ProgressView().controlSize(.small)
                            } else if model.id == options.current {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Theme.tint)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(applying || forking)
                    .accessibilityIdentifier("session.model.\(model.id)")
                }
            } else if let loadError {
                VStack(spacing: 8) {
                    Text(loadError)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Retry") { Task { await loadOptions() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.tint)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            } else {
                HStack {
                    ProgressView()
                    Text("Loading models…").foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Model")
        } footer: {
            if options != nil {
                Text("A live session switches immediately; an idle one picks the model up when it wakes.")
            }
        }
    }

    @State private var pendingModelId: String?

    private func switchModel(_ model: SessionModelOptions.Model) async {
        guard !applying, model.id != options?.current else { return }
        applying = true
        pendingModelId = model.id
        errorMessage = nil
        confirmation = nil
        defer { applying = false; pendingModelId = nil }
        do {
            let result = try await api.setSessionModel(id: session.id, model: model.id)
            // Adopt the server's read-back truth into the picker state.
            if let options {
                self.options = SessionModelOptions(
                    models: options.models,
                    current: result.effectiveModel ?? result.model,
                    currentEffort: options.currentEffort
                )
            }
            let name = result.effectiveModel ?? result.model
            // Codex/ACP sessions report `applied` instead of `appliedLive` —
            // both mean the switch took effect immediately.
            confirmation = (result.appliedLive == true || result.applied == true)
                ? "Switched to \(Self.shortName(name, in: options)) — applied to the running session."
                : "Switched to \(Self.shortName(name, in: options)) — takes effect when the session next wakes."
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            errorMessage = Self.friendlyControlError(error)
        }
    }

    // MARK: - Effort

    @ViewBuilder
    private var effortSection: some View {
        if let model = currentModel, model.supportsEffort == true {
            let levels = model.supportedEffortLevels ?? ["low", "medium", "high"]
            Section {
                HStack(spacing: 8) {
                    ForEach(levels, id: \.self) { level in
                        let selected = options?.currentEffort == level
                        Button {
                            Task { await switchEffort(level) }
                        } label: {
                            Text(level.capitalized)
                                .font(.subheadline.weight(selected ? .semibold : .regular))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .background(
                                    selected ? Theme.tint.opacity(0.15) : Color(.tertiarySystemFill),
                                    in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                )
                                .foregroundStyle(selected ? Theme.tint : .primary)
                        }
                        .buttonStyle(.plain)
                        .disabled(applying || forking)
                        .accessibilityIdentifier("session.effort.\(level)")
                    }
                }
            } header: {
                Text("Reasoning Effort")
            }
        }
    }

    private func switchEffort(_ level: String) async {
        guard !applying, options?.currentEffort != level else { return }
        applying = true
        errorMessage = nil
        confirmation = nil
        defer { applying = false }
        do {
            let result = try await api.setSessionEffort(id: session.id, effort: level)
            if let options {
                self.options = SessionModelOptions(
                    models: options.models,
                    current: options.current,
                    currentEffort: result.effectiveEffort ?? result.effort
                )
            }
            if result.overridden == true, let effective = result.effectiveEffort {
                confirmation = "Requested \(result.effort) — the session is actually using \(effective) (overridden)."
            } else {
                confirmation = result.appliedLive == true
                    ? "Effort set to \(result.effort) — applied live."
                    : "Effort set to \(result.effort) — takes effect when the session next wakes."
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            errorMessage = Self.friendlyControlError(error)
        }
    }

    // MARK: - Provider controls (Wave 2 — mode select etc.)

    /// One section per select-type control from GET /sessions/:id/controls.
    /// For Claude sessions this is the permission-mode switch; Codex/ACP
    /// sessions surface their native control set.
    @ViewBuilder
    private var providerControlsSection: some View {
        if let controls {
            ForEach(controls.controls.filter { $0.type == "select" && !($0.options ?? []).isEmpty }) { control in
                Section {
                    ForEach(control.options ?? []) { option in
                        Button {
                            Task { await applyControl(control, option) }
                        } label: {
                            HStack {
                                Text(option.label)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if applying && pendingControlValue == "\(control.id)|\(option.value)" {
                                    ProgressView().controlSize(.small)
                                } else if option.value == control.currentValue {
                                    Image(systemName: "checkmark")
                                        .font(.body.weight(.semibold))
                                        .foregroundStyle(Theme.tint)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(applying || forking)
                        .accessibilityIdentifier("session.control.\(control.id).\(option.value)")
                    }
                } header: {
                    Text(control.name ?? control.id.capitalized)
                }
            }
        }
    }

    @State private var pendingControlValue: String?

    private func applyControl(_ control: SessionControlsPayload.Control, _ option: SessionControlsPayload.Option) async {
        guard !applying, option.value != control.currentValue else { return }
        applying = true
        pendingControlValue = "\(control.id)|\(option.value)"
        errorMessage = nil
        confirmation = nil
        defer { applying = false; pendingControlValue = nil }
        do {
            let updated = try await api.applySessionControl(
                id: session.id, controlId: control.id, value: option.value
            )
            controls = updated
            confirmation = "\(control.name ?? control.id.capitalized) set to \(option.label)."
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            AppLog.info("session", "applied session control", [
                "sessionId": session.id, "controlId": control.id, "value": option.value,
            ])
        } catch {
            errorMessage = Self.friendlyControlError(error)
        }
    }

    // MARK: - Fork

    private var forkSection: some View {
        Section {
            TextField("Optional first message for the fork", text: $forkMessage, axis: .vertical)
                .lineLimit(2...4)
                .accessibilityIdentifier("session.forkMessage")
            Button {
                Task { await fork() }
            } label: {
                HStack {
                    if forking {
                        ProgressView().controlSize(.small)
                        Text("Forking…")
                    } else {
                        Label("Fork Session", systemImage: "arrow.triangle.branch")
                    }
                }
            }
            .disabled(forking || applying)
            .accessibilityIdentifier("session.fork")
        } header: {
            Text("Fork")
        } footer: {
            Text("Creates a sibling task with a copy of this conversation — the original keeps running untouched.")
        }
    }

    private func fork() async {
        guard !forking else { return }
        forking = true
        errorMessage = nil
        confirmation = nil
        defer { forking = false }
        do {
            let message = forkMessage.trimmingCharacters(in: .whitespacesAndNewlines)
            let created = try await api.forkSession(id: session.id, message: message.isEmpty ? nil : message)
            // Same launch-stash pattern as NewSessionSheet: paint the first
            // message instantly on the pushed page (spawn is async).
            if !message.isEmpty {
                SessionLaunchContext.stash(sessionId: created.sessionId, message: message)
            }
            AppLog.info("session", "forked session", [
                "sourceSessionId": session.id, "sessionId": created.sessionId,
            ])
            let now = ISO8601DateFormatter().string(from: Date())
            let forked = WalnutSession(
                id: created.sessionId,
                title: created.title,
                taskId: created.taskId,
                taskTitle: created.title,
                project: session.project,
                host: session.host,
                processStatus: "idle",
                model: session.model,
                mode: session.mode,
                startedAt: now,
                lastActiveAt: now,
                messageCount: 0,
                cwd: session.cwd,
                pinned: nil,
                focusTier: nil,
                description: nil
            )
            onForked(forked)
            dismiss()
        } catch {
            errorMessage = Self.friendlyControlError(error)
        }
    }

    // MARK: - Helpers

    /// Prefer the catalog label for a model id in user-facing copy.
    static func shortName(_ id: String, in options: SessionModelOptions?) -> String {
        options?.models.first(where: { $0.id == id })?.label ?? id
    }

    /// Honest copy for the cloud-relay failure ladder + control errors.
    static func friendlyControlError(_ error: Error) -> String {
        guard let apiError = error as? APIError else { return error.localizedDescription }
        switch apiError.code {
        case "session_control_needs_upgrade":
            return "Your primary box's daemon is upgrading for mobile session control — try again in a minute."
        case "bridge_offline":
            return "The primary box isn't reachable right now — try again when it reconnects."
        case "conflict":
            return apiError.localizedDescription // e.g. unsupported effort level
        case "not_found":
            return "This session no longer exists on the server."
        default:
            return apiError.localizedDescription
        }
    }
}
