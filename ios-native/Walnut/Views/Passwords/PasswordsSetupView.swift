import SwiftUI

/// The first open on this iPhone: what Passwords does here, then the master password (and the
/// Secret Key when the link to the Mac is not private).
struct PasswordsSetupView: View {
    let store: PasswordsStore

    @State private var password = ""
    @State private var secretKey = ""
    @State private var privateLink: Bool?
    @State private var working = false
    @State private var error: String?
    @FocusState private var field: Field?

    enum Field { case password, secretKey }

    private var model: VaultModel { store.model }
    private var needsSecretKey: Bool { privateLink == false && !model.secretKeyStored }
    private var noVaultOnMac: Bool { model.syncError == .noVault && model.header == nil }

    var body: some View {
        ScrollViewReader { proxy in
        List {
            Section {
                VStack(spacing: 14) {
                    ZStack {
                        Circle().fill(Theme.tintSoft).frame(width: 76, height: 76)
                        Image(systemName: "key.fill").font(.system(size: 30, weight: .semibold)).foregroundStyle(Theme.tint)
                    }
                    .accessibilityHidden(true)
                    Text("Passwords on This iPhone").font(.title2.bold()).multilineTextAlignment(.center)
                    Text("Use your Walnut passwords on this iPhone. Unlock them once with your master password; add and edit them on your Mac.")
                        .font(.body).foregroundStyle(Theme.secondaryOnCard).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .listRowBackground(Color.clear)
            }
            if noVaultOnMac {
                Section {
                    Label("Set up Passwords in Walnut on your Mac first (Walnut, Passwords). Then come back here.", systemImage: "desktopcomputer")
                        .foregroundStyle(Color.secondary)
                    Button("Check Again") { Task { await check() } }.tint(Theme.tint)
                }
            } else {
                form
            }
            Section("How it works") {
                point("rectangle.and.pencil.and.ellipsis", "Fills in Safari and apps", "Your logins, verification codes and passkeys, above the keyboard. Where nothing is saved for a page, tap the key, then Walnut.")
                point("faceid", "Unlocks with Face ID", "Enter your master password once. After that, Face ID opens it.")
                point("arrow.triangle.2.circlepath", "Changes come from your Mac", "Add and edit them in Walnut on your Mac or in the browser extension. This iPhone does not save new ones: a password you save while signing up here goes to Apple's Passwords app.")
                point("lock.shield.fill", "Stays encrypted", "This iPhone opens your passwords itself. Your Mac and the cloud only pass along locked data.")
            }
        }
        .listStyle(.insetGrouped)
        .vaultTabBarClearance()
        .scrollDismissesKeyboard(.interactively)
        .task { await check() }
        // A wrong password puts the keyboard back over the button: bring the button above it
        // once the keyboard is up (scrolled before, the list has nothing to scroll for).
        .onChange(of: error) { _, e in
            guard e != nil else { return }
            Task {
                try? await Task.sleep(for: .milliseconds(450))
                withAnimation { proxy.scrollTo("passwords.setup.submit", anchor: .bottom) }
            }
        }
        }
    }

    private func point(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol).font(.title3).foregroundStyle(Theme.tint).frame(width: 30)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(text).font(.subheadline).foregroundStyle(Theme.secondaryOnCard).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var form: some View {
        Section {
            SecureField("Master password", text: $password)
                .textContentType(.password)
                .focused($field, equals: .password)
                .submitLabel(needsSecretKey ? .next : .go)
                .onSubmit {
                    if needsSecretKey { field = .secretKey } else { Task { await setUp() } }
                }
                .accessibilityIdentifier("passwords.setup.password")
            if needsSecretKey {
                HStack {
                    TextField("Secret Key (W1-…)", text: $secretKey)
                        .font(.system(.body, design: .monospaced))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .focused($field, equals: .secretKey)
                        .submitLabel(.go)
                        .onSubmit { Task { await setUp() } }
                        .accessibilityIdentifier("passwords.setup.secretKey")
                    PasteButton(payloadType: String.self) { strings in
                        if let s = strings.first { secretKey = s.trimmingCharacters(in: .whitespacesAndNewlines) }
                    }
                    .labelStyle(.iconOnly)
                    .buttonBorderShape(.capsule)
                    .tint(Theme.tint)
                }
            }
        } header: {
            Text("Your Walnut master password")
        } footer: {
            if let error {
                // Under the field it is about, not under the button.
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.dangerText)
                    .accessibilityIdentifier("passwords.setup.error")
            } else if needsSecretKey {
                Text("This connection to your Mac is not private, so Walnut does not send your Secret Key over it. Your Secret Key starts with W1-. Find it in the recovery kit you saved, or on your Mac: Walnut Settings, Passwords, Recovery and advanced, Show Secret Key.").foregroundStyle(Theme.secondaryOnCard)
            } else if privateLink == true {
                Text("Your Mac sends the Secret Key over this private connection, so the master password is all you need.").foregroundStyle(Theme.secondaryOnCard)
            }
        }
        Section {
            Button {
                Task { await setUp() }
            } label: {
                HStack {
                    Spacer()
                    if working { ProgressView().tint(.white) } else { Text("Unlock and Set Up").font(.headline) }
                    Spacer()
                }
                .frame(minHeight: 36)
            }
            .disabled(password.isEmpty || (needsSecretKey && secretKey.isEmpty) || working || privateLink == nil)
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .accessibilityIdentifier("passwords.setup.submit")
            .id("passwords.setup.submit")
        }
    }

    private func check() async {
        await model.sync()
        if let server = AppConfig.serverURL.flatMap({ url in AppConfig.token.map { VaultServer(baseURL: url, token: $0) } }) {
            privateLink = await VaultClient(server: server).privateLink()
        } else {
            privateLink = false
        }
        if model.syncError == .notPaired { error = VaultSyncError.notPaired.message }
    }

    private func setUp() async {
        guard !password.isEmpty, !working else { return }
        working = true
        defer { working = false }
        error = nil
        do {
            try await model.setUp(password: password, secretKeyText: needsSecretKey ? secretKey : "")
            password = ""
            secretKey = ""
            await store.refreshAutofillState()
        } catch let e as VaultModel.SetUpError {
            if e == .secretKeyNeeded { privateLink = false; field = .secretKey }
            if e == .wrongMasterPassword || e == .wrongPassword { password = ""; field = .password }
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }
}
