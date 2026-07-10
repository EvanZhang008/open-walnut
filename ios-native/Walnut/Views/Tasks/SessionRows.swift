import SwiftUI

/// One session row in the Tasks panel's Sessions tab — status dot, title,
/// host/model chips, relative activity time. Read-only (v1 projection).
struct SessionRowView: View {
    let session: WalnutSession

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            statusDot
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    if session.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(Theme.tint)
                    }
                    Text(session.displayTitle)
                        .font(.body)
                        .lineLimit(2)
                }
                HStack(spacing: 6) {
                    chip(session.isLocal ? "Mac" : session.host,
                         icon: session.isLocal ? "laptopcomputer" : "server.rack")
                    if let model = session.model {
                        chip(shortModel(model), icon: nil)
                    }
                    if let when = session.lastActiveValue {
                        Text(when.formatted(.relative(presentation: .named)))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 9, height: 9)
    }

    private var statusColor: Color {
        switch session.statusKind {
        case .running: return Theme.success
        case .idle: return Theme.warning
        case .error: return Theme.danger
        case .stopped, .unknown: return Color(.systemGray3)
        }
    }

    private func chip(_ text: String, icon: String?) -> some View {
        HStack(spacing: 3) {
            if let icon {
                Image(systemName: icon).font(.system(size: 9))
            }
            Text(text).font(.caption2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color(.tertiarySystemFill), in: Capsule())
        .foregroundStyle(.secondary)
    }

    /// "global.anthropic.claude-opus-4-8[1m]" → "Opus 4.8". Full version
    /// digits matter ("Opus 4.8", never a bare "Opus") — strip decorations
    /// like "[1m]" or "-v1" BEFORE parsing so they can't eat a version part.
    private func shortModel(_ model: String) -> String {
        var lower = model.lowercased()
        while let bracket = lower.range(of: "[", options: .backwards) {
            lower = String(lower[..<bracket.lowerBound])
        }
        for family in ["opus", "sonnet", "haiku", "fable"] where lower.contains(family) {
            if let range = lower.range(of: family) {
                let tail = lower[range.upperBound...]
                let digits = tail.split(separator: "-")
                    .prefix(while: { !$0.isEmpty && $0.allSatisfy(\.isNumber) })
                    .prefix(2)
                let version = digits.joined(separator: ".")
                let name = family.prefix(1).uppercased() + family.dropFirst()
                return version.isEmpty ? name : "\(name) \(version)"
            }
        }
        return model
    }
}

/// Read-only session detail — projection metadata + the exported transcript
/// tail (the primary box exports tails for every session it can reach, local
/// or SSH). Steering the session still needs the console (Phase 2 bridge).
struct SessionDetailSheet: View {
    let session: WalnutSession

    @State private var transcript: SessionTranscript?
    @State private var transcriptMissing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        SessionRowView(session: session)
                    }
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                }

                transcriptSection

                Section("Details") {
                    row("Status", session.processStatus.capitalized)
                    row("Machine", session.isLocal ? "Mac (primary)" : session.host)
                    if let model = session.model { row("Model", model) }
                    if let mode = session.mode { row("Mode", mode.capitalized) }
                    row("Messages", "\(session.messageCount)")
                    if let started = WalnutTask.parseISO(session.startedAt) {
                        row("Started", started.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let active = session.lastActiveValue {
                        row("Last active", active.formatted(date: .abbreviated, time: .shortened))
                    }
                    if let cwd = session.cwd {
                        row("Directory", cwd)
                    }
                }

                if let taskTitle = session.taskTitle {
                    Section("Task") {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(taskTitle)
                            if let category = session.category {
                                Text([category, session.project].compactMap { $0 }.joined(separator: " › "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let description = session.description, !description.isEmpty {
                    Section("About") {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Label(
                        "Read-only view. Steering opens on your Walnut console until the primary bridge ships.",
                        systemImage: "info.circle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Session")
            .navigationBarTitleDisplayMode(.inline)
            .task { await loadTranscript() }
        }
    }

    // MARK: - Transcript tail

    @ViewBuilder
    private var transcriptSection: some View {
        if let transcript, !transcript.messages.isEmpty {
            Section("Conversation") {
                if transcript.truncated {
                    Text("Showing the last \(transcript.messages.count) entries")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                ForEach(Array(transcript.messages.enumerated()), id: \.offset) { _, message in
                    transcriptRow(message)
                }
            }
        } else if transcriptMissing {
            Section("Conversation") {
                Text("Transcript not synced for this session yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else if transcript == nil {
            Section("Conversation") {
                HStack {
                    ProgressView()
                    Text("Loading transcript…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func transcriptRow(_ message: SessionTranscript.Message) -> some View {
        if message.kind == "tool" {
            HStack(spacing: 5) {
                Image(systemName: "wrench.and.screwdriver")
                    .font(.caption2)
                Text(message.text)
                    .font(.caption)
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(message.role == "user" ? "You" : "Agent")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(message.role == "user" ? Theme.tint : .secondary)
                Text(message.text)
                    .font(.subheadline)
                    .lineLimit(12)
            }
            .padding(.vertical, 2)
        }
    }

    private func loadTranscript() async {
        do {
            transcript = try await WalnutAPI().sessionTranscript(id: session.id)
        } catch {
            transcriptMissing = true
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
                .lineLimit(3)
                .font(.callout)
        }
    }
}
