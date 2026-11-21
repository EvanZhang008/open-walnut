import SwiftUI

/// One approval a script waits on: what it asks, who asked, the detail, the time left,
/// and the answer: Approve and Deny, one tap each, on this phone as on every device the person
/// is signed in on (2026-11-21, the user: a signed-in device approves; no key, never a dimmed Approve).
struct ApprovalSheet: View {
    let approval: Approval
    @State private var center = ApprovalCenter.shared
    @State private var working: String?
    @State private var error: String?
    @State private var detailsOpen = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    /// At the accessibility text sizes a row of two buttons wraps a letter per line: stack them.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    // An answer that failed says why right here, above everything that can be long.
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("approval.error")
                    }
                    // The request in words is read whole; only a technical detail folds (2026-11-14,
                    // the user: "summayr一直都显示不需要点detail detail只是xommend detail啥的").
                    if let words = approval.words {
                        Text(words).font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("approval.words")
                    }
                    if let tech = approval.technicalDetail {
                        DisclosureGroup(isExpanded: $detailsOpen) {
                            Text(tech.text)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                                .accessibilityIdentifier("approval.detail")
                        } label: {
                            // On the label, not the group: a group's identifier is given to its content too,
                            // and the opened detail then read as approval.details (lane B, 2026-11-15).
                            Text(tech.bound ? "Details (used once)" : "Details").font(.subheadline)
                                .accessibilityIdentifier("approval.details")
                        }
                    }
                }
                .padding(20)
            }
            .safeAreaInset(edge: .bottom) { footer.padding(.horizontal, 20).padding(.bottom, 12).background(.bar) }
            .navigationTitle("Approval")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { center.close(approval) }.accessibilityIdentifier("approval.close")
                }
            }
        }
        .accessibilityIdentifier("approval.sheet")
        // Walnut's summary comes a few seconds after the ask: read it again until it is here.
        .task(id: approval.awaitsSummary) {
            guard approval.awaitsSummary else { return }
            for _ in 0..<4 {
                try? await Task.sleep(for: .seconds(2))
                if Task.isCancelled { return }
                await center.refresh()
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            let row = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))
            row {
                Label("Needs your OK", systemImage: "checkmark.shield")
                if !stacked { Spacer() }
                if approval.isPending, let end = approval.expiresDate {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(end <= ctx.date ? "Expired" : Self.left(until: end, now: ctx.date))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.secondary)
            // What the step does and why, in full (2026-11-14, the user: "I need the summary AI write").
            let lead = approval.lead
            Text(lead.text)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier(lead.byWalnut ? "approval.summary" : "approval.what")
            if let why = lead.why {
                Text(why).font(.body).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("approval.why")
            }
            if lead.byWalnut {
                Text("Walnut\u{2019}s summary of the task\u{2019}s session: the lines below are what you approve")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("approval.summaryBy")
                // The request's own line, the one you approve, stays in sight under it.
                Text(approval.what).font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("approval.what")
            }
            Text(approval.requesterLine).font(.subheadline).foregroundStyle(.secondary)
            // Where it acts: the repository and the branch a Git push names, else the folder.
            if let repo = approval.repoLine {
                (Text("Repo  ").foregroundStyle(.secondary) + Text(repo))
                    .font(.caption.monospaced()).lineLimit(3)
                    .accessibilityIdentifier("approval.repo")
            } else if let cwd = approval.requester.cwd {
                Text(Approval.shortPath(cwd)).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }

    /// The bottom bar, read again every second: a request whose time ran out while the sheet is
    /// open says so at once instead of keeping buttons that can only fail (2026-11-15).
    private var footer: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let state = Self.footer(for: approval, now: ctx.date)
            footerBody(state)
                // The whole bar, in every state: the end state once drew as a small box in the
                // middle of the bar (the user, 2026-11-15: "just a small box of deny").
                .frame(maxWidth: .infinity)
                .animation(.easeInOut(duration: 0.2), value: state)
        }
    }

    @ViewBuilder private func footerBody(_ state: Footer) -> some View {
        switch state {
        case .answer:
            let buttons = stacked ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
            buttons {
                // Approve and Deny always come together, and both always answer: disabled only while
                // this phone's own answer is on its way.
                if !stacked { denyButton }
                approveButton
                if stacked { denyButton }
            }
            .disabled(working != nil)
            .transition(.opacity)
        case let .ended(line, status):
            VStack(spacing: 10) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: status == "approved" ? "checkmark.circle.fill" : "xmark.circle").accessibilityHidden(true)
                    Text(line)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("approval.result")
                }
                .font(.headline)
                .foregroundStyle(status == "approved" ? .green : status == "denied" ? .red : .secondary)
                Button { center.close(approval) } label: { Text("Done").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .accessibilityIdentifier("approval.done")
            }
            .transition(.opacity)
        }
    }

    private var approveButton: some View {
        Button { run("approve") } label: {
            Text(working == "approve" ? "Approving\u{2026}" : "Approve")
                .lineLimit(1)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .accessibilityIdentifier("approval.approve")
    }

    /// What the bottom bar offers for one approval at one moment.
    enum Footer: Equatable {
        /// Still waiting: Deny and Approve, always both, always live.
        case answer
        /// Answered, withdrawn or out of time: one line that says which, and Done. No answer buttons.
        case ended(line: String, status: String)
    }

    static func footer(for a: Approval, now: Date) -> Footer {
        if a.isPending, let end = a.expiresDate, end <= now {
            return .ended(line: "Expired: nobody answered in time", status: "expired")
        }
        guard a.isPending else { return .ended(line: endLine(a), status: a.status) }
        return .answer
    }

    private var denyButton: some View {
        Button(role: .destructive) { run("deny") } label: {
            Text(working == "deny" ? "Denying…" : "Deny").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityIdentifier("approval.deny")
    }

    private func run(_ decision: String) {
        working = decision
        error = nil
        Task {
            do {
                _ = try await center.answer(approval, decision: decision)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            }
            working = nil
        }
    }

    static func left(until end: Date, now: Date) -> String {
        let s = max(0, Int(end.timeIntervalSince(now)))
        if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m left" }
        return String(format: "%d:%02d left", s / 60, s % 60)
    }

    /// Where it was answered, as the person knows the device: the Mac app's own name is its host's
    /// (a hash in a container), so it is called the Mac app; a phone by its name.
    static func deviceWords(_ answer: ApprovalAnswerRecord) -> String? {
        if answer.device.kind == "mac-app" { return "in the Walnut Mac app" }
        let name = answer.device.name.trimmingCharacters(in: .whitespaces)
        return name.isEmpty || name == "unknown" ? nil : "on \(name)"
    }

    static func endLine(_ a: Approval) -> String {
        switch a.status {
        case "approved":
            guard let device = a.answer.flatMap(deviceWords) else { return "Approved" }
            return "Approved \(device)"
        case "denied":
            guard let device = a.answer.flatMap(deviceWords) else { return "Denied" }
            return "Denied \(device)"
        case "expired": return "Expired: nobody answered in time"
        case "canceled": return "Withdrawn: the script stopped asking"
        default: return "No longer waiting for an answer"
        }
    }
}
