import SwiftUI

/// What a list shows: everything, or one kind.
enum PasswordsFilter: String, CaseIterable, Identifiable, Hashable {
    case all, passkeys, codes, other
    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .passkeys: return "Passkeys"
        case .codes: return "Codes"
        case .other: return "Cards, Keys & Notes"
        }
    }

    var symbol: String {
        switch self {
        case .all: return "key.fill"
        case .passkeys: return "person.badge.key.fill"
        case .codes: return "clock.badge.checkmark.fill"
        case .other: return "creditcard.fill"
        }
    }

    var color: Color {
        switch self {
        case .all: return Color(red: 0.16, green: 0.45, blue: 0.85)
        case .passkeys: return Color(red: 0.16, green: 0.62, blue: 0.38)
        case .codes: return Color(red: 0.90, green: 0.58, blue: 0.10)
        case .other: return Color(red: 0.45, green: 0.45, blue: 0.50)
        }
    }

    func includes(_ item: VaultItem) -> Bool {
        switch self {
        case .all: return true
        case .passkeys: return !(item.passkeys ?? []).isEmpty
        case .codes: return item.hasTotp
        case .other: return item.type != .login
        }
    }
}

/// Unlocked: search, the four kinds as tiles, AutoFill's switch, favorites.
struct PasswordsHomeView: View {
    let store: PasswordsStore
    @State private var query = ""
    @State private var confirmRemove = false
    @State private var toast: String?
    /// The tile opened. Tiles are buttons, not links: two links in one List row add a chevron
    /// beside each tile and share one tap.
    @State private var openFilter: PasswordsFilter?
    @Environment(\.dynamicTypeSize) private var typeSize

    private var model: VaultModel { store.model }

    /// Two tiles a row, one at the accessibility text sizes, where two cut "Passkeys" short.
    private var tileColumns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: 12), count: typeSize.isAccessibilitySize ? 1 : 2)
    }

    var body: some View {
        List {
            if query.isEmpty {
                Section {
                    LazyVGrid(columns: tileColumns, spacing: 12) {
                        ForEach(PasswordsFilter.allCases) { f in
                            Button { openFilter = f } label: { tile(f) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("passwords.tile.\(f.rawValue)")
                        }
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } footer: {
                    // How fresh this copy is, where it shows without scrolling: the phone may be
                    // filling from a copy made while the Mac was away.
                    VStack(alignment: .leading, spacing: 4) {
                        Text(syncLine).foregroundStyle(Theme.secondaryOnCard)
                        if model.unreadable > 0 {
                            Text("\(model.unreadable) item\(model.unreadable == 1 ? "" : "s") could not be opened on this iPhone.").foregroundStyle(Theme.secondaryOnCard)
                        }
                    }
                    .padding(.top, 4)
                    .accessibilityIdentifier("passwords.syncLine")
                }
                autofillSection
                let favorites = model.items.filter { $0.favorite == true }
                if !favorites.isEmpty {
                    Section("Favorites") {
                        ForEach(favorites) { item in
                            NavigationLink { PasswordDetailView(item: item) } label: { VaultItemRow(item: item) }
                        }
                    }
                }
            } else {
                let results = model.search(query)
                if results.isEmpty {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                } else {
                    Section("\(results.count) result\(results.count == 1 ? "" : "s")") {
                        ForEach(results) { item in
                            NavigationLink { PasswordDetailView(item: item) } label: { VaultItemRow(item: item) }
                                .accessibilityIdentifier("passwords.row.\(item.title)")
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .vaultTabBarClearance()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search passwords")
        .refreshable { await model.sync() }
        .navigationDestination(item: $openFilter) { PasswordsListView(store: store, filter: $0) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        Task { await model.sync() }
                    } label: { Label("Update from Mac", systemImage: "arrow.clockwise") }
                    Button(role: .destructive) {
                        confirmRemove = true
                    } label: { Label("Remove from iPhone", systemImage: "iphone.slash") }
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
                .accessibilityIdentifier("passwords.more")
            }
        }
        .confirmationDialog("Remove Passwords from this iPhone?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove from iPhone", role: .destructive) { Task { await store.removeFromThisPhone() } }
        } message: {
            Text("The passwords stay in Walnut on your Mac. To use them here again, you enter your master password once more.")
        }
        .vaultToast($toast)
        .vaultPrivacyCover()
        .vaultGate()
    }

    private var syncLine: String {
        if model.syncing { return "Updating from your Mac…" }
        if let e = model.syncError, e != .noVault { return e.message }
        return VaultSyncedText.line(model.syncedAt)
    }

    private func count(_ f: PasswordsFilter) -> Int { model.items.filter(f.includes).count }

    private func tile(_ f: PasswordsFilter) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                ZStack {
                    Circle().fill(f.color)
                    Image(systemName: f.symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                }
                .frame(width: 34, height: 34)
                Spacer()
                Text("\(count(f))").font(.title2.bold()).foregroundStyle(Color.primary).monospacedDigit()
            }
            Text(f.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.secondary)
                .lineLimit(2).minimumScaleFactor(0.8).fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        // Tiles side by side share their height, so one that wraps leaves no ragged edge.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(uiColor: .secondarySystemGroupedBackground)))
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(f.title), \(count(f))")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder private var autofillSection: some View {
        Section {
            if store.autofillEnabled == true {
                // Done once, so one quiet row, not a card.
                Label {
                    Text("AutoFill is on")
                } icon: {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("passwords.autofillOn")
            } else {
                HStack(spacing: 12) {
                    Label {
                        Text("AutoFill is off")
                    } icon: {
                        Image(systemName: "rectangle.and.pencil.and.ellipsis").foregroundStyle(Theme.tint)
                    }
                    Spacer(minLength: 8)
                    Button("Turn On") { Task { await store.turnOnAutofill() } }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.tint)
                        .accessibilityIdentifier("passwords.turnOnAutofill")
                }
            }
        } header: {
            Text("AutoFill")
        } footer: {
            if store.autofillEnabled == true {
                Text("Walnut logins show above the keyboard when you sign in.").foregroundStyle(Theme.secondaryOnCard)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Turn it on and your Walnut logins show above the keyboard in Safari and other apps.").foregroundStyle(Theme.secondaryOnCard)
                    Button("Or turn it on in Settings: General, AutoFill & Passwords") { store.openAutofillSettings() }
                        .font(.footnote).tint(Theme.tint)
                }
            }
        }
    }
}

/// One kind of item, by title.
struct PasswordsListView: View {
    let store: PasswordsStore
    let filter: PasswordsFilter
    @State private var query = ""

    var body: some View {
        let items = store.model.search(query, in: store.model.items.filter(filter.includes))
        List {
            if items.isEmpty {
                if query.isEmpty {
                    ContentUnavailableView("No \(filter.title)", systemImage: filter.symbol,
                                           description: Text(emptyText)).listRowBackground(Color.clear)
                } else {
                    ContentUnavailableView.search(text: query).listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(items) { item in
                        NavigationLink {
                            PasswordDetailView(item: item)
                        } label: {
                            if filter == .codes, let t = TOTP.parse(item.totp ?? "") {
                                VaultItemRow(item: item, trailing: AnyView(VaultOneTimeCodeView(totp: t, font: .system(.callout, design: .monospaced).weight(.semibold))), trailingBesideTitle: true)
                            } else {
                                VaultItemRow(item: item, showsPasskeyBadge: filter != .passkeys)
                            }
                        }
                        .accessibilityIdentifier("passwords.row.\(item.title)")
                    }
                } footer: {
                    Text("\(items.count) item\(items.count == 1 ? "" : "s")")
                }
            }
        }
        .listStyle(.insetGrouped)
        .vaultTabBarClearance()
        .navigationTitle(filter.title)
        .navigationBarTitleDisplayMode(.inline)
        .vaultPrivacyCover()
        .vaultGate()
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search \(filter.title.lowercased())")
        .refreshable { await store.model.sync() }
    }

    private var emptyText: String {
        switch filter {
        case .all: return "Save logins in Walnut on your Mac or in the browser extension."
        case .passkeys: return "Passkeys you keep in Walnut show up here."
        case .codes: return "Logins with a one-time code set up show up here."
        case .other: return "Cards, secure notes and API keys show up here."
        }
    }
}
