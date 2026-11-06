import SwiftUI

/// One item: every field it holds, each one copy away. Read only here: an item is changed in
/// Walnut on the Mac or in the browser extension, and the change shows up on this iPhone.
struct PasswordDetailView: View {
    let item: VaultItem
    @State private var revealed: Set<String> = []
    @State private var toast: String?
    /// The big header shows the title; the bar shows it only once that has scrolled away.
    @State private var headerGone = false

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    VaultItemIcon(item: item, size: 52)
                    Text(item.title).font(.title3.bold()).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
            }
            mainSection
            if let passkeys = item.passkeys, !passkeys.isEmpty {
                Section("Passkeys") {
                    ForEach(passkeys, id: \.self) { pk in
                        HStack(spacing: 12) {
                            Image(systemName: "person.badge.key.fill").foregroundStyle(Theme.tint).frame(width: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(pk.userName ?? pk.userDisplayName ?? "Passkey").font(.body)
                                Text(pk.rpId ?? "").font(.subheadline).foregroundStyle(Color.secondary)
                            }
                            Spacer()
                            if !PasskeySigner.canSign(pk) {
                                Text("Not usable here").font(.footnote).foregroundStyle(Color.secondary)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            if let urls = item.urls, !urls.isEmpty {
                Section(urls.count == 1 ? "Website" : "Websites") {
                    ForEach(urls, id: \.self) { u in
                        HStack(spacing: 4) {
                            if let url = URL(string: u) {
                                Link(destination: url) {
                                    HStack {
                                        Text(SiteMatch.host(of: u) ?? u).foregroundStyle(Theme.tint)
                                        Spacer()
                                        Image(systemName: "arrow.up.right.square").foregroundStyle(Color.secondary)
                                    }
                                }
                                .accessibilityLabel("Open \(SiteMatch.host(of: u) ?? u)")
                            } else {
                                Text(u)
                                Spacer()
                            }
                            copyButton({ u }, label: "Website", done: "Website copied")
                        }
                    }
                }
            }
            if let fields = item.fields, !fields.isEmpty {
                Section("Fields") {
                    ForEach(Array(fields.enumerated()), id: \.offset) { i, f in
                        secretRow(f.name.isEmpty ? "Field" : f.name, f.value, key: "field\(i)", hidden: f.hidden == true)
                    }
                }
            }
            if let notes = item.notes, !notes.isEmpty {
                if item.type == .note {
                    // A secure note is the secret itself: hidden like a password until shown.
                    Section { secretRow("Note", notes, key: "notes", hidden: true) }
                } else {
                    Section("Notes") {
                        Text(notes).textSelection(.enabled).font(.body)
                            .contextMenu { Button { copy(notes, "Notes copied") } label: { Label("Copy", systemImage: "doc.on.doc") } }
                    }
                }
            }
            Section {
                EmptyView()
            } footer: {
                VStack(alignment: .leading, spacing: 4) {
                    if let updated = item.updatedAt.flatMap(Self.date) {
                        Text("Changed \(updated.formatted(date: .abbreviated, time: .shortened))").foregroundStyle(Theme.secondaryOnCard)
                    }
                    Text("To change this item, edit it in Walnut on your Mac or in the browser extension.").foregroundStyle(Theme.secondaryOnCard)
                }
            }
        }
        .listStyle(.insetGrouped)
        .vaultTabBarClearance()
        .onScrollGeometryChange(for: Bool.self) { g in g.contentOffset.y + g.contentInsets.top > 90 } action: { _, gone in
            headerGone = gone
        }
        .navigationTitle(headerGone ? item.title : "")
        .navigationBarTitleDisplayMode(.inline)
        .vaultToast($toast)
        .vaultPrivacyCover()
        .vaultGate()
    }

    @ViewBuilder private var mainSection: some View {
        switch item.type {
        case .card:
            Section {
                if let h = item.card?.holder, !h.isEmpty { plainRow("Cardholder", h) }
                if let n = item.card?.number, !n.isEmpty { secretRow("Card Number", n, key: "number", hidden: true, mono: true) }
                if let m = item.card?.expMonth, let y = item.card?.expYear, !m.isEmpty || !y.isEmpty { plainRow("Expires", "\(m)/\(y)") }
                if let c = item.card?.code, !c.isEmpty { secretRow("Security Code", c, key: "code", hidden: true, mono: true) }
            }
        case .api_key:
            Section {
                if let e = item.envName, !e.isEmpty { plainRow("Variable", e, mono: true) }
                if let p = item.password, !p.isEmpty { secretRow("Key", p, key: "password", hidden: true, mono: true) }
            }
        default:
            if item.hasUsername || item.hasPassword || item.hasTotp {
                Section {
                    if let u = item.username, !u.isEmpty { plainRow("User Name", u) }
                    if let p = item.password, !p.isEmpty { secretRow("Password", p, key: "password", hidden: true, mono: true) }
                    if let t = TOTP.parse(item.totp ?? "") { codeRow(t) }
                }
            }
        }
    }

    private static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    private func copy(_ value: String, _ what: String) {
        VaultClipboard.copy(value)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        toast = what
    }

    /// The row's own copy control: tapping the row copies too, but that is not visible.
    private func copyButton(_ value: @escaping () -> String, label: String, done: String) -> some View {
        Button {
            copy(value(), done)
        } label: {
            Image(systemName: "doc.on.doc").font(.body).foregroundStyle(Theme.tint)
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Copy \(label)")
        .accessibilityIdentifier("passwords.detail.copy.\(label)")
    }

    private func plainRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(spacing: 4) {
            plainRowBody(label, value, mono: mono)
            copyButton({ value }, label: label, done: "\(label) copied")
        }
    }

    private func plainRowBody(_ label: String, _ value: String, mono: Bool) -> some View {
        Button {
            copy(value, "\(label) copied")
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(label).font(.footnote).foregroundStyle(Color.secondary)
                Text(value).font(mono ? .system(.body, design: .monospaced) : .body).foregroundStyle(Color.primary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityHint("Copies it")
        .accessibilityIdentifier("passwords.detail.\(label)")
    }

    private func secretRow(_ label: String, _ value: String, key: String, hidden: Bool, mono: Bool = false) -> some View {
        let shown = !hidden || revealed.contains(key)
        return HStack(spacing: 4) {
            Button {
                copy(value, "\(label) copied, clears in 90 seconds")
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(label).font(.footnote).foregroundStyle(Color.secondary)
                    Text(shown ? value : String(repeating: "•", count: 12))
                        .font(mono && shown ? .system(.body, design: .monospaced) : .body)
                        .foregroundStyle(Color.primary)
                        .lineLimit(shown ? nil : 1)
                        .privacySensitive()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityHint("Copies it")
            .accessibilityIdentifier("passwords.detail.\(label)")
            if hidden {
                Button {
                    if revealed.contains(key) { revealed.remove(key) } else { revealed.insert(key) }
                } label: {
                    Image(systemName: shown ? "eye.slash" : "eye").font(.body).foregroundStyle(Theme.tint)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(shown ? "Hide \(label)" : "Show \(label)")
                .accessibilityIdentifier("passwords.detail.reveal.\(label)")
            }
            copyButton({ value }, label: label, done: "\(label) copied, clears in 90 seconds")
        }
    }

    private func codeRow(_ t: TOTP) -> some View {
        HStack(spacing: 4) {
            codeRowBody(t)
            copyButton({ t.code(at: Date()).code }, label: "Code", done: "Code copied")
        }
    }

    private func codeRowBody(_ t: TOTP) -> some View {
        Button {
            copy(t.code(at: Date()).code, "Code copied")
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text("Verification Code").font(.footnote).foregroundStyle(Color.secondary)
                VaultOneTimeCodeView(totp: t)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityHint("Copies it")
        .accessibilityIdentifier("passwords.detail.code")
    }
}
