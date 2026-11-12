import SwiftUI

/// One approval a script waits on: what it asks, who asked, the detail, the time left,
/// and the answer. A biometric approval's Approve runs Face ID and signs on this phone.
struct ApprovalSheet: View {
    let approval: Approval
    @State private var center = ApprovalCenter.shared
    @State private var working: String?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    /// At the accessibility text sizes a row of two buttons wraps a letter per line: stack them.
    private var stacked: Bool { typeSize.isAccessibilitySize }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let detail = approval.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityIdentifier("approval.detail")
                    }
                    if let note = approval.downgraded {
                        Text(note).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error {
                        Text(error).font(.footnote).foregroundStyle(.red).accessibilityIdentifier("approval.error")
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
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            let row = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 6))
            row {
                Label(approval.isBiometric ? "Needs Face ID" : "Needs your OK",
                      systemImage: approval.isBiometric ? "faceid" : "checkmark.shield")
                if !stacked { Spacer() }
                if approval.isPending, let end = approval.expiresDate {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(Self.left(until: end, now: ctx.date))
                            .font(.footnote.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .font(.footnote.weight(.semibold))
            .foregroundStyle(approval.isBiometric ? Theme.tint : .secondary)
            Text(approval.what)
                .font(.title3.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("approval.what")
            Text(approval.requesterLine).font(.subheadline).foregroundStyle(.secondary)
            if let cwd = approval.requester.cwd {
                Text(cwd).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }

    @ViewBuilder private var footer: some View {
        if approval.isPending {
            VStack(spacing: 10) {
                if approval.isBiometric && !center.canSign(approval) {
                    Text(center.whereToApprove(approval))
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                let buttons = stacked ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
                buttons {
                    if !stacked { denyButton }
                    if !approval.isBiometric {
                        Button { run("approve", signed: false) } label: {
                            Text(working == "approve" ? "Approving…" : "Approve").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("approval.approve")
                    } else if center.canSign(approval) {
                        Button { run("approve", signed: true) } label: {
                            Label(working == "approve" ? "Face ID…" : "Approve with Face ID", systemImage: "faceid")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .accessibilityIdentifier("approval.approve")
                    }
                    // Stacked, Approve leads and Deny comes under it.
                    if stacked { denyButton }
                }
                .disabled(working != nil)
            }
        } else {
            VStack(spacing: 10) {
                Label(Self.endLine(approval), systemImage: approval.status == "approved" ? "checkmark.circle.fill" : "xmark.circle")
                    .font(.headline)
                    .foregroundStyle(approval.status == "approved" ? .green : approval.status == "denied" ? .red : .secondary)
                    .accessibilityIdentifier("approval.result")
                Button("Done") { center.close(approval) }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
            }
        }
    }

    private var denyButton: some View {
        Button(role: .destructive) { run("deny", signed: false) } label: {
            Text(working == "deny" ? "Denying…" : "Deny").frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityIdentifier("approval.deny")
    }

    private func run(_ decision: String, signed: Bool) {
        working = decision
        error = nil
        Task {
            do {
                _ = try await center.answer(approval, decision: decision, signed: signed)
            } catch let e as ApprovalSigning.Unavailable {
                error = e.errorDescription
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

    static func endLine(_ a: Approval) -> String {
        switch a.status {
        case "approved":
            let how = a.answer?.mode != "biometric" ? "with a tap"
                : a.answer?.device.kind == "mac-app" ? "with Touch ID" : "with Face ID"
            return "Approved on \(a.answer?.device.name ?? "a device") \(how)"
        case "denied": return "Denied on \(a.answer?.device.name ?? "a device")"
        case "expired": return "Expired: nobody answered in time"
        default: return "Withdrawn by the script"
        }
    }
}
