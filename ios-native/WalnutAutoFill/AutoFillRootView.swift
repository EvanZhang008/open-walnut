import SwiftUI

struct AutoFillPasskeyRequest: Equatable {
    var rpId: String
    var clientDataHash: Data
    /// Credential ids the site accepts; empty means any of this site's passkeys.
    var allowed: [Data]
}

enum AutoFillKind: Equatable {
    case password
    case oneTimeCode
    case passkey(AutoFillPasskeyRequest)
}

enum AutoFillProvide: Equatable {
    case password(record: String)
    case oneTimeCode(record: String)
    case passkey(record: String, request: AutoFillPasskeyRequest)
}

enum AutoFillMode: Equatable {
    case list(hosts: [String], kind: AutoFillKind)
    case provide(AutoFillProvide)
    case configure
    case passkeyRegistration
}

enum AutoFillResult {
    case password(user: String, password: String)
    case oneTimeCode(String)
    case passkey(PasskeySigner.Assertion, rpId: String, clientDataHash: Data)
    case configured
    case canceled
    case notFound
}

/// One row of the passkey list: an item and one of its passkeys.
struct AutoFillPasskeyChoice: Identifiable {
    var item: VaultItem
    var passkey: VaultPasskey
    var id: String { "\(item.id)#\(passkey.credentialId ?? "")" }
}

/// Everything the AutoFill sheet shows: the lock, then the list or the one fill iOS asked for.
struct AutoFillRootView: View {
    let model: VaultModel
    let mode: AutoFillMode
    let finish: (AutoFillResult) -> Void

    @State private var query = ""
    @State private var configuredCount: Int?
    @State private var provideError: String?
    /// A login picked for a page it was not saved for waits here until the person confirms.
    @State private var crossSite: VaultItem?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(mode == .configure ? "Done" : "Cancel") { finish(mode == .configure ? .configured : .canceled) }
                            .accessibilityIdentifier("autofill.cancel")
                    }
                }
        }
        .tint(Theme.tint)
        .onChange(of: model.phase) { _, phase in
            if phase == .unlocked { afterUnlock() }
        }
        .task {
            if model.phase == .unlocked { afterUnlock() }
        }
    }

    private var title: String {
        switch mode {
        case .list(_, .oneTimeCode): return "Verification Codes"
        case .list(_, .passkey): return "Passkeys"
        case .configure: return "Walnut"
        default: return "Walnut Passwords"
        }
    }

    @ViewBuilder private var content: some View {
        if mode == .passkeyRegistration {
            // Nothing to unlock for: Walnut makes no passkeys here.
            passkeyRegistration
        } else {
            phaseContent
        }
    }

    @ViewBuilder private var phaseContent: some View {
        switch model.phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .notSetUp:
            notSetUp
        case .locked, .needsPassword:
            VaultUnlockView(model: model, purpose: lockPurpose, title: lockTitle, autoBiometrics: true)
        case .unlocked:
            unlocked
        }
    }

    private var lockTitle: String {
        switch mode {
        case .provide(.passkey), .list(_, .passkey): return "Confirm to Sign In"
        case .list, .provide: return "Confirm to Fill"
        case .configure, .passkeyRegistration: return "Passwords Are Locked"
        }
    }

    private var lockPurpose: String {
        switch mode {
        case .list(let hosts, _):
            return hosts.first.map { "Unlock to fill in a password for \($0)." } ?? "Unlock to choose a password."
        case .provide(.oneTimeCode): return "Unlock to fill in the verification code."
        case .provide(.passkey): return "Unlock to sign in with your passkey."
        case .provide: return "Unlock to fill in this password."
        case .configure: return "Unlock once so iOS can suggest your Walnut passwords above the keyboard."
        case .passkeyRegistration: return ""
        }
    }

    private var notSetUp: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(Theme.tintSoft).frame(width: 84, height: 84)
                Image(systemName: "key.fill").font(.system(size: 34, weight: .semibold)).foregroundStyle(Theme.tint)
            }
            .accessibilityHidden(true)
            Text("Set Up Passwords First").font(.title2.bold())
            Text("Open the Walnut app, go to Settings, then Passwords, and unlock with your master password once. Your passwords then fill in here.")
                .font(.body).foregroundStyle(Color.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("autofill.notSetUp")
    }

    @ViewBuilder private var unlocked: some View {
        switch mode {
        case .list(let hosts, let kind): listView(hosts: hosts, kind: kind)
        case .provide: VStack { if let provideError { Text(provideError).padding() } else { ProgressView() } }
        case .configure: configured
        case .passkeyRegistration: passkeyRegistration
        }
    }

    // MARK: - After Face ID

    private func afterUnlock() {
        if case .provide(let p) = mode { provide(p); return }
        if mode == .configure { configuredCount = model.items.count }
        // The newest copy from the Mac, quietly: the list shows the cached one meanwhile.
        Task {
            await model.sync()
            if mode == .configure { configuredCount = model.items.count }
        }
    }

    private func provide(_ p: AutoFillProvide) {
        switch p {
        case .password(let record):
            let (id, _) = CredentialIdentities.parse(record: record)
            guard let item = model.items.first(where: { $0.id == id }), let pw = item.password else { finish(.notFound); return }
            finish(.password(user: item.username ?? "", password: pw))
        case .oneTimeCode(let record):
            let (id, _) = CredentialIdentities.parse(record: record)
            guard let item = model.items.first(where: { $0.id == id }), let t = TOTP.parse(item.totp ?? "") else { finish(.notFound); return }
            finish(.oneTimeCode(t.code(at: Date()).code))
        case .passkey(let record, let request):
            let (id, cid) = CredentialIdentities.parse(record: record)
            guard let item = model.items.first(where: { $0.id == id }),
                  let pk = (item.passkeys ?? []).first(where: { $0.credentialId == cid }),
                  let a = PasskeySigner.assert(pk, rpId: request.rpId, clientDataHash: request.clientDataHash)
            else { finish(.notFound); return }
            finish(.passkey(a, rpId: request.rpId, clientDataHash: request.clientDataHash))
        }
    }

    // MARK: - The list

    private func listView(hosts: [String], kind: AutoFillKind) -> some View {
        List {
            switch kind {
            case .password, .oneTimeCode:
                let base = model.items.filter { kind == .oneTimeCode ? $0.hasTotp : ($0.type == .login && ($0.hasPassword || $0.hasUsername)) }
                let suggested = query.isEmpty ? model.suggested(for: hosts).filter { s in base.contains { $0.id == s.id } } : []
                let rest = model.search(query, in: base).filter { o in !suggested.contains { $0.id == o.id } }
                // On a page with nothing saved, logins for a site like it (localhost for
                // 127.0.0.1, another host of the same name) come first.
                let similar = query.isEmpty ? rest.filter { SiteMatch.similar(item: $0, pageHosts: hosts) } : []
                let others = rest.filter { o in !similar.contains { $0.id == o.id } }
                if !suggested.isEmpty {
                    Section {
                        ForEach(suggested) { row($0, kind: kind, hosts: hosts) }
                    } header: {
                        Text("Suggested for \(hosts.first ?? "")")
                    }
                }
                if !similar.isEmpty {
                    Section {
                        ForEach(similar) { row($0, kind: kind, hosts: hosts) }
                    } header: {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Nothing is saved for \(hosts.first ?? "this page").")
                                .font(.subheadline).foregroundStyle(Theme.secondaryOnCard).textCase(nil)
                            Text("Similar sites").font(.footnote.weight(.semibold)).foregroundStyle(Color.secondary).textCase(nil)
                        }
                    }
                }
                if !others.isEmpty {
                    Section {
                        ForEach(others) { row($0, kind: kind, hosts: hosts) }
                    } header: {
                        pickerHeader(similar.isEmpty ? othersHeader(hosts: hosts, kind: kind, suggested: !suggested.isEmpty)
                                                     : (kind == .oneTimeCode ? "Other codes" : "Other logins"))
                    } footer: {
                        Text(VaultSyncedText.line(model.syncedAt))
                    }
                }
                if suggested.isEmpty && others.isEmpty {
                    emptyState(hosts: hosts, kind: kind)
                }
            case .passkey(let request):
                let choices = passkeys(for: request)
                if choices.isEmpty {
                    ContentUnavailableView("No Passkey for \(request.rpId)", systemImage: "person.badge.key",
                                           description: Text("Walnut has no passkey saved for this site. Use another way to sign in."))
                        .listRowBackground(Color.clear)
                } else {
                    Section("Sign in to \(request.rpId)") {
                        ForEach(choices) { c in
                            Button {
                                guard let a = PasskeySigner.assert(c.passkey, rpId: request.rpId, clientDataHash: request.clientDataHash) else { return }
                                finish(.passkey(a, rpId: request.rpId, clientDataHash: request.clientDataHash))
                            } label: {
                                HStack(spacing: 12) {
                                    VaultItemIcon(item: c.item)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(c.passkey.userName ?? c.item.username ?? c.item.title).font(.body.weight(.medium)).foregroundStyle(Color.primary)
                                        Text("Passkey · \(c.item.title)").font(.subheadline).foregroundStyle(Color.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search Walnut")
        .refreshable { await model.sync() }
        .accessibilityIdentifier("autofill.list")
        // An alert, centred: iOS 26 draws a confirmation dialog as a popover pointing at the list.
        .alert(AutoFillCrossSite.title(crossSite, hosts: hosts), isPresented: Binding(
            get: { crossSite != nil }, set: { if !$0 { crossSite = nil } }), presenting: crossSite) { item in
            Button("Fill on \(hosts.first ?? "this page")", role: .destructive) {
                finish(.password(user: item.username ?? "", password: item.password ?? ""))
            }
            .accessibilityIdentifier("autofill.crossSite.fill")
            Button("Cancel", role: .cancel) { crossSite = nil }
        } message: { _ in
            Text("Fill it only if you trust this page.")
        }
    }

    private func passkeys(for request: AutoFillPasskeyRequest) -> [AutoFillPasskeyChoice] {
        let rp = request.rpId.lowercased()
        return model.items.flatMap { item in
            (item.passkeys ?? []).compactMap { pk -> AutoFillPasskeyChoice? in
                guard pk.rpId == rp, PasskeySigner.canSign(pk) else { return nil }
                if !request.allowed.isEmpty {
                    guard let cid = pk.credentialId.flatMap(PasskeySigner.credentialIdBytes), request.allowed.contains(cid) else { return nil }
                }
                return AutoFillPasskeyChoice(item: item, passkey: pk)
            }
        }
    }

    /// A caption, not a heading: the rows are what the person reads.
    private func pickerHeader(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Color.secondary).textCase(nil)
    }

    /// Names the page the pick is for, so a login for another site is chosen knowingly.
    private func othersHeader(hosts: [String], kind: AutoFillKind, suggested: Bool) -> String {
        if !query.isEmpty { return "Results" }
        if suggested { return "Other passwords" }
        let what = kind == .oneTimeCode ? "code" : "login"
        if let host = hosts.first { return "Nothing saved for \(host). Choose a \(what) to fill in:" }
        return kind == .oneTimeCode ? "All codes" : "All passwords"
    }

    @ViewBuilder private func row(_ item: VaultItem, kind: AutoFillKind, hosts: [String]) -> some View {
        Button {
            if kind == .oneTimeCode, let t = TOTP.parse(item.totp ?? "") {
                finish(.oneTimeCode(t.code(at: Date()).code))
            } else if AutoFillCrossSite.needsConfirm(item: item, hosts: hosts) {
                crossSite = item
            } else {
                finish(.password(user: item.username ?? "", password: item.password ?? ""))
            }
        } label: {
            if kind == .oneTimeCode, let t = TOTP.parse(item.totp ?? "") {
                VaultItemRow(item: item, trailing: AnyView(VaultOneTimeCodeView(totp: t, font: .system(.callout, design: .monospaced).weight(.semibold))), showsSite: true, trailingBesideTitle: true)
            } else {
                VaultItemRow(item: item, showsSite: true, showsPasskeyBadge: false)
            }
        }
        .accessibilityIdentifier("autofill.item.\(item.title)")
    }

    @ViewBuilder private func emptyState(hosts: [String], kind: AutoFillKind) -> some View {
        if !query.isEmpty {
            ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
        } else if kind == .oneTimeCode {
            ContentUnavailableView("No Verification Codes", systemImage: "clock.badge.checkmark",
                                   description: Text("None of your Walnut logins has a one-time code set up."))
                .listRowBackground(Color.clear)
        } else {
            ContentUnavailableView("No Passwords Yet", systemImage: "key",
                                   description: Text("Save logins in Walnut on your Mac or in the browser extension, and they show up here."))
                .listRowBackground(Color.clear)
        }
    }

    // MARK: - Turned on

    private var configured: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(Theme.success.opacity(0.15)).frame(width: 84, height: 84)
                Image(systemName: "checkmark").font(.system(size: 34, weight: .bold)).foregroundStyle(Theme.success)
            }
            .accessibilityHidden(true)
            Text("Walnut Is Ready").font(.title2.bold())
            Text(configuredCount.map { "\($0) passwords from Walnut now fill in on this iPhone. Look for them above the keyboard when you sign in." }
                 ?? "Walnut passwords now fill in on this iPhone.")
                .font(.body).foregroundStyle(Color.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                finish(.configured)
            } label: {
                Text("Done").font(.headline).frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
            .padding(.top, 6)
            .accessibilityIdentifier("autofill.configuredDone")
        }
        .padding(28)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var passkeyRegistration: some View {
        VStack(spacing: 18) {
            ZStack {
                Circle().fill(Theme.tintSoft).frame(width: 84, height: 84)
                Image(systemName: "person.badge.key.fill").font(.system(size: 34, weight: .semibold)).foregroundStyle(Theme.tint)
            }
            .accessibilityHidden(true)
            Text("Save This Passkey Elsewhere").font(.title2.bold())
            Text("Walnut signs in with the passkeys you already keep in it, but it saves new passkeys only on your Mac for now. Choose another place to save this one.")
                .font(.body).foregroundStyle(Color.secondary).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                finish(.canceled)
            } label: {
                Text("Choose Another Place").font(.headline).frame(maxWidth: .infinity, minHeight: 30)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.tint)
        }
        .padding(28)
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

