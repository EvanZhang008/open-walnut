import LocalAuthentication
import SwiftUI

/// The lock screen the app's Passwords screen and the AutoFill sheet share: Face ID first, the
/// master password when Face ID cannot (it changed, the key was removed, the master password
/// changed on the Mac, or the person picks it).
struct VaultUnlockView: View {
    let model: VaultModel
    /// Shown under the title ("to fill in a password for example.com").
    var purpose: String = "Your passwords are locked."
    /// The AutoFill sheet's own title: the person asked for a fill there, so "Locked" read like
    /// something had gone wrong.
    var title = "Passwords Are Locked"
    /// Asks for Face ID as soon as the screen shows (the AutoFill sheet).
    var autoBiometrics = false

    @State private var password = ""
    @State private var usePassword = false
    @State private var working = false
    @State private var error: String?
    @FocusState private var focused: Bool

    private var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Passcode"
        }
    }

    private var biometrySymbol: String {
        switch biometryName {
        case "Face ID": return "faceid"
        case "Touch ID": return "touchid"
        case "Optic ID": return "opticid"
        default: return "lock.fill"
        }
    }

    private var needsPassword: String? {
        if case .needsPassword(let why) = model.phase { return why }
        return nil
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                ZStack {
                    Circle().fill(Theme.tintSoft).frame(width: 84, height: 84)
                    Image(systemName: "lock.fill").font(.system(size: 34, weight: .semibold)).foregroundStyle(Theme.tint)
                }
                .padding(.top, 36)
                .accessibilityHidden(true)
                VStack(spacing: 8) {
                    Text(title).font(.title2.bold())
                    Text(needsPassword ?? purpose)
                        .font(.body).foregroundStyle(Color.secondary).multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if needsPassword != nil || usePassword {
                    passwordForm
                } else {
                    Button {
                        Task { await biometrics() }
                    } label: {
                        Label("Unlock with \(biometryName)", systemImage: biometrySymbol)
                            .font(.headline).frame(maxWidth: .infinity, minHeight: 30)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.tint)
                    .disabled(working)
                    .accessibilityIdentifier("passwords.unlockBiometrics")
                    Button("Use Master Password") {
                        usePassword = true
                        focused = true
                    }
                    .font(.subheadline.weight(.medium))
                    .tint(Theme.tint)
                    .accessibilityIdentifier("passwords.useMasterPassword")
                }
                if let error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(Theme.dangerText)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("passwords.unlockError")
                }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .task {
            guard autoBiometrics, needsPassword == nil, model.phase == .locked else { return }
            // In the AutoFill sheet iOS may refuse Face ID while the sheet is still appearing.
            for _ in 0..<6 {
                guard await biometrics() == .notNow, !Task.isCancelled else { return }
                try? await Task.sleep(for: .milliseconds(400))
            }
        }
    }

    private var passwordForm: some View {
        VStack(spacing: 14) {
            SecureField("Master password", text: $password)
                .textContentType(.password)
                .submitLabel(.go)
                .focused($focused)
                .onSubmit { Task { await unlockWithPassword() } }
                .padding(.horizontal, 14).frame(minHeight: 50)
                .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color(uiColor: .secondarySystemGroupedBackground)))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.secondary.opacity(0.25)))
                .accessibilityIdentifier("passwords.masterPassword")
            Button {
                Task { await unlockWithPassword() }
            } label: {
                Group {
                    if working { ProgressView().tint(Theme.onTint) } else { Text("Unlock").font(.headline) }
                }
                .frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .disabled(password.isEmpty || working)
            .accessibilityIdentifier("passwords.unlockPassword")
            if needsPassword == nil {
                Button("Use \(biometryName) Instead") {
                    usePassword = false
                    error = nil
                    Task { await biometrics() }
                }
                .font(.subheadline.weight(.medium))
                .tint(Theme.tint)
            }
        }
        .onAppear { focused = true }
    }

    @discardableResult
    private func biometrics() async -> VaultModel.UnlockOutcome {
        working = true
        defer { working = false }
        error = nil
        let outcome = await model.unlockWithBiometrics()
        switch outcome {
        case .unlocked, .canceled, .notNow: break
        case .needsPassword: usePassword = true; focused = true
        }
        return outcome
    }

    private func unlockWithPassword() async {
        guard !password.isEmpty, !working else { return }
        working = true
        defer { working = false }
        error = nil
        do {
            try await model.unlock(password: password)
            password = ""
        } catch let e as VaultModel.SetUpError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
    }
}
