import SwiftUI

/// The Settings row that leads to Passwords.
struct PasswordsSettingsSection: View {
    @State private var store = PasswordsStore.shared

    var body: some View {
        Section {
            NavigationLink {
                PasswordsView()
            } label: {
                LabeledContent {
                    Text(rowValue)
                } label: {
                    Label("Passwords", systemImage: "key.fill")
                }
            }
            .accessibilityIdentifier("settings.passwords")
        } footer: {
            Text("Fill in your Walnut passwords in Safari and other apps, unlocked with Face ID.").foregroundStyle(Theme.secondaryOnCard)
        }
        .task { await store.refreshAutofillState() }
    }

    private var rowValue: String {
        switch store.model.phase {
        case .loading: return ""
        case .notSetUp: return "Set Up"
        case .locked, .needsPassword: return "Locked"
        case .unlocked: return store.autofillEnabled == true ? "AutoFill On" : "Unlocked"
        }
    }
}

/// Passwords on this iPhone: set up once with the master password, then Face ID.
struct PasswordsView: View {
    @State private var store = PasswordsStore.shared
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            switch store.model.phase {
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case .notSetUp:
                PasswordsSetupView(store: store)
            case .locked, .needsPassword:
                VaultUnlockView(model: store.model, purpose: "Unlock with Face ID to see and copy your passwords.",
                                autoBiometrics: !store.lockedByHand)
                    .background(Color(uiColor: .systemGroupedBackground))
            case .unlocked:
                PasswordsHomeView(store: store)
            }
        }
        .navigationTitle("Passwords")
        .navigationBarTitleDisplayMode(.inline)
        .barPage(Color(uiColor: .systemGroupedBackground))
        .toolbarColorScheme(colorScheme, for: .navigationBar)
        .toolbar {
            if store.model.phase == .unlocked {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        store.lockByHand()
                    } label: {
                        Label("Lock", systemImage: "lock.fill")
                    }
                    .accessibilityIdentifier("passwords.lock")
                }
            }
        }
        .onDisappear { store.clearLockedByHand() }
        .task {
            store.model.load()
            await store.refreshAutofillState()
            await store.model.sync()
        }
    }
}

/// Every Passwords screen shows vault content only while it is unlocked. A list or an item
/// pushed above Passwords stays on the navigation stack when the vault locks (time away, the
/// phone locking), so each one puts the lock in its own place and comes back as it was once
/// unlocked (2026-11-06: an item stayed open after four minutes away).
private struct VaultGate: ViewModifier {
    @State private var store = PasswordsStore.shared

    func body(content: Content) -> some View {
        switch store.model.phase {
        case .unlocked:
            content
        case .locked, .needsPassword:
            VaultUnlockView(model: store.model, purpose: "Unlock with Face ID to see and copy your passwords.",
                            autoBiometrics: !store.lockedByHand)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle("Passwords")
                .background(Color(uiColor: .systemGroupedBackground))
        case .loading, .notSetUp:
            Color(uiColor: .systemGroupedBackground)
        }
    }
}

extension View {
    func vaultGate() -> some View { modifier(VaultGate()) }
}
