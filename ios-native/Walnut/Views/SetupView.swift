import SwiftUI

/// First-run setup — server URL + device token (or a pasted wn://pair link),
/// with a live "Test connection" against GET /api/v1/status before saving.
struct SetupView: View {
    @Environment(ConnectionStore.self) private var connection
    /// Read for ONE reason: to say out loud that a delivered quick action has no
    /// consumer while this view is the root (see the modifier at the end of
    /// `body`).
    @State private var quickAction = VoiceQuickAction.shared

    @State private var serverURL = ""
    @State private var token = ""
    @State private var deviceName = ""
    @State private var busy = false
    @State private var testResult: TestResult?
    @State private var alertMessage: String?
    @State private var showScanner = false

    private enum TestResult {
        case success(ServerStatus)
        case failure(String)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    hero
                    form
                }
                .padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(.systemBackground))
            // The page runs up behind the empty bar and the status bar, so a
            // scrolled form never shows under the Dynamic Island (AX5 App Store
            // gate, r5b: Connect slid up under the clock).
            .barPage(Color(.systemBackground))
            // The diagnostic heartbeat names the screen on show. Without a name
            // here, the pairing screen (where Disconnect lands) kept reporting
            // a tab of the tab view it replaced. A ROOT screen, because those
            // retained tabs can still run their appear hooks after this one.
            .freezeRootScreen("setup")
            .alert("Walnut", isPresented: .init(
                get: { alertMessage != nil },
                set: { if !$0 { alertMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(alertMessage ?? "")
            }
            .sheet(isPresented: $showScanner) {
                QRScannerSheet { payload in
                    applyPairingText(payload, autoConnect: true)
                }
            }
            // The silence that made an unpaired quick action undiagnosable. A
            // Home-screen "Voice to Walnut" on an unpaired app arms the mailbox
            // and then nothing happens: RootView is showing THIS view, so there
            // is no MainTabView to switch tabs and no composer to consume the
            // request, and the TTL retires it two minutes later without a word.
            // `VoiceQuickAction.clear(reason:)` deliberately isn't called for
            // this state, so setup is the honest owner of the fact — it is the
            // thing that knows why there is no consumer.
            // `initial: true` covers both arrival orders with one hook: armed
            // before setup appeared (cold launch straight from the Home screen)
            // and armed while setup was already on screen (warm delivery).
            .onChange(of: quickAction.pending, initial: true) { _, request in
                guard let request else { return }
                AppLog.warn("voice", "quick action is pending but the app is unpaired", [
                    "source": request.source, "screen": "setup",
                ])
            }
        }
    }

    private var hero: some View {
        VStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Theme.tintSoft)
                .frame(width: 76, height: 76)
                .overlay {
                    Image(systemName: "sparkles")
                        .font(.system(size: 34))
                        .foregroundStyle(Theme.tint)
                }
            Text("Walnut")
                .font(.largeTitle.bold())
            Text("Your Personal AI for tasks, notes and conversations, everywhere.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
        }
        .padding(.top, 40)
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            fieldLabel("SERVER ADDRESS")
            // Text(verbatim:) prompt — a plain string placeholder is treated as
            // LocalizedStringKey markdown, which renders the URL as a blue link.
            TextField(text: $serverURL, prompt: Text(verbatim: "https://wn.example.com")) { EmptyView() }
                .textFieldStyle(.setup)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("setup.serverURL")

            fieldLabel("DEVICE TOKEN")
            SecureField("From \"walnut device add\"", text: $token)
                .textFieldStyle(.setup)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("setup.token")

            fieldLabel("DEVICE NAME")
            TextField("e.g. iPhone", text: $deviceName)
                .textFieldStyle(.setup)
                .autocorrectionDisabled()
                .accessibilityIdentifier("setup.deviceName")

            testResultRow

            Button {
                showScanner = true
            } label: {
                Label("Scan QR from your console", systemImage: "qrcode.viewfinder")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            .background(Theme.tint, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(Theme.onTint)
            .disabled(busy)
            .accessibilityIdentifier("setup.scan")

            Button(action: connect) {
                Group {
                    if busy {
                        ProgressView().tint(Theme.tint)
                    } else {
                        Text("Connect").fontWeight(.semibold)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 48)
            }
            .background(Theme.tintSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .foregroundStyle(Theme.tint)
            .disabled(busy)
            .accessibilityIdentifier("setup.connect")

            // One line while both fit; stacked when they do not (AX5 broke
            // "Test connection" into four lines beside its neighbour).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) {
                    testButton
                    Text("·").foregroundStyle(.tertiary)
                    pasteButton
                }
                VStack(spacing: 14) {
                    testButton
                    pasteButton
                }
            }
            .font(.subheadline.weight(.medium))
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)

            DemoEntryButton(disabled: busy)

            PrivacyPolicyLink()
        }
    }

    private var testButton: some View {
        Button("Test connection", action: testConnection)
            .disabled(busy)
            .accessibilityIdentifier("setup.test")
    }

    private var pasteButton: some View {
        Button("Paste pairing link", action: pastePairingLink)
            .disabled(busy)
    }

    @ViewBuilder
    private var testResultRow: some View {
        switch testResult {
        case .success(let status):
            Label(
                "Connected: \(status.mode.rawValue) · v\(status.version)",
                systemImage: "checkmark.circle.fill"
            )
            .font(.footnote)
            .foregroundStyle(Theme.success)
        case .failure(let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(Theme.danger)
        case nil:
            EmptyView()
        }
    }

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.leading, 4)
    }

    // MARK: - Actions

    private func testConnection() {
        guard !serverURL.trimmingCharacters(in: .whitespaces).isEmpty else {
            alertMessage = "Enter your Walnut server URL first."
            return
        }
        busy = true
        testResult = nil
        Task {
            do {
                let status = try await WalnutAPI().testStatus(serverURL: serverURL, token: token)
                testResult = .success(status)
            } catch {
                testResult = .failure(error.localizedDescription)
            }
            busy = false
        }
    }

    private func connect() {
        guard !serverURL.trimmingCharacters(in: .whitespaces).isEmpty else {
            alertMessage = "Enter your Walnut server URL."
            return
        }
        // A server on this same machine trusts loopback callers, so its status
        // check passes with no token at all and the phone "paired" with nothing
        // that names it: every device-scoped call after that was refused (400 on
        // `POST /devices/self`). Pairing always needs a device token.
        let deviceToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !deviceToken.isEmpty else {
            alertMessage = "Enter the device token from \"walnut device add\", or scan the QR code from your console."
            return
        }
        busy = true
        Task {
            do {
                try await connection.connect(
                    serverURL: serverURL,
                    token: deviceToken,
                    deviceName: deviceName.isEmpty ? nil : deviceName
                )
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } catch {
                alertMessage = "Connection failed: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    private func pastePairingLink() {
        // `.string` can be nil for promised/synced pasteboard items even when
        // hasStrings is true — fall back to loading via the item provider.
        if let direct = UIPasteboard.general.string {
            applyPairingText(direct)
            return
        }
        guard let provider = UIPasteboard.general.itemProviders.first,
              provider.canLoadObject(ofClass: NSString.self)
        else {
            applyPairingText(nil)
            return
        }
        _ = provider.loadObject(ofClass: NSString.self) { object, _ in
            DispatchQueue.main.async {
                applyPairingText(object as? String)
            }
        }
    }

    private func applyPairingText(_ text: String?, autoConnect: Bool = false) {
        guard let text, let pair = AppConfig.parsePairingURI(text) else {
            alertMessage = "Copy a wn://pair link (from \"walnut device add\") and try again."
            return
        }
        token = pair.token
        if let name = pair.name { deviceName = name }
        if let server = pair.server { serverURL = server }
        if serverURL.trimmingCharacters(in: .whitespaces).isEmpty {
            alertMessage = "Token filled in. Enter the server address and connect."
            return
        }
        // A scanned console QR carries server+token — pairing is one tap: none.
        if autoConnect { connect() }
    }
}

/// Rounded, filled text-field style shared by the setup form.
private struct SetupFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding(.horizontal, 14)
            .frame(height: 46)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private extension TextFieldStyle where Self == SetupFieldStyle {
    static var setup: SetupFieldStyle { SetupFieldStyle() }
}
