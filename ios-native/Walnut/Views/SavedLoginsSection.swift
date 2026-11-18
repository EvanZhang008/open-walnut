import SwiftUI

/// The pairing screen's list of Walnuts this phone signed in to (`SavedLogins`): a tap
/// signs in again with the kept token, no QR code. "Forget Login" in a row's menu deletes
/// that login from the phone; nothing changes on the server. A login the server refused
/// says so in its row and is never retried on its own.
struct SavedLoginsSection: View {
    @Environment(ConnectionStore.self) private var connection
    @Binding var busy: Bool
    @Binding var alertMessage: String?

    @State private var reconnecting: String?
    @State private var forgetting: SavedLogin?

    private var logins: [SavedLogin] { connection.savedLogins }

    var body: some View {
        VStack(spacing: 0) {
            if !logins.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("SAVED LOGINS")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                    ForEach(logins) { login in row(login) }
                    Text("Or pair a new Walnut below.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog(
            forgetting.map { "Forget the login for \($0.title)?" } ?? "",
            isPresented: .init(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }),
            titleVisibility: .visible,
            presenting: forgetting
        ) { login in
            Button("Forget Login", role: .destructive) { connection.forgetSavedLogin(login) }
            .accessibilityIdentifier("setup.savedLogin.forgetConfirm")
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("To connect to it again you'll need to scan a new QR code from its console. Nothing changes on the server.")
        }
    }

    private func row(_ login: SavedLogin) -> some View {
        HStack(spacing: 4) {
            Button { reconnect(login) } label: {
                HStack(spacing: 12) {
                    Image(systemName: login.removedByServer ? "exclamationmark.triangle.fill" : "desktopcomputer")
                        .font(.title3)
                        .foregroundStyle(login.removedByServer ? Theme.danger : Theme.tint)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(login.title)
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Text(subtitle(login))
                            .font(.footnote)
                            .foregroundStyle(login.removedByServer ? Theme.danger : .secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    if reconnecting == login.id { ProgressView() }
                }
                .frame(minHeight: 52)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(busy)
            .accessibilityIdentifier("setup.savedLogin")

            Menu {
                Button(role: .destructive) { forgetting = login } label: {
                    Label("Forget Login", systemImage: "trash")
                }
                .accessibilityIdentifier("setup.savedLogin.forget")
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(busy)
            .accessibilityLabel("More for \(login.title)")
            .accessibilityIdentifier("setup.savedLogin.menu")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func subtitle(_ login: SavedLogin) -> String {
        if login.removedByServer { return "Removed from this Walnut. Scan a new QR code to connect." }
        let used = login.lastUsedAt.formatted(.relative(presentation: .named))
        return "Tap to reconnect · used \(used)"
    }

    private func reconnect(_ login: SavedLogin) {
        guard !busy else { return }
        busy = true
        reconnecting = login.id
        Task {
            let outcome = await connection.reconnect(login)
            reconnecting = nil
            busy = false
            switch outcome {
            case .connected:
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            case .refused:
                alertMessage = "\(login.title) refused this phone's saved login. If the phone was removed in its console, scan a new QR code to connect."
            case .removedByServer:
                alertMessage = ConnectionStore.removedMessage(login.title)
            case .unreachable(let why):
                let detail = why.isEmpty ? "" : " \(why)"
                alertMessage = "Couldn't reach \(login.title).\(detail) Check that it's running and this phone can reach it, then tap it again."
            }
        }
    }
}
