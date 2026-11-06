import Foundation
import LocalAuthentication
import Observation

/// Passwords on this iPhone, for the app's Passwords screen and the AutoFill extension alike.
///
/// The phone opens the vault itself: it fetches the ciphertext (VaultClient), keeps it in the app
/// group (VaultCache), and opens it with the vault key, which it gets once from the master password
/// and the Secret Key and keeps in the Keychain behind Face ID (VaultKeychain). Nothing it shows
/// was ever plaintext off this phone.
@MainActor
@Observable
final class VaultModel {
    enum Phase: Equatable {
        /// Reading the cache.
        case loading
        /// This iPhone has never opened the vault: set it up.
        case notSetUp
        /// Set up; the vault key waits behind Face ID.
        case locked
        /// The vault key here no longer opens the vault (a new master password on the Mac, Face ID
        /// changed): the master password again.
        case needsPassword(String)
        case unlocked
    }

    private(set) var phase: Phase = .loading
    /// Open items, not in the trash, by title.
    private(set) var items: [VaultItem] = []
    private(set) var header: VaultHeader?
    private(set) var syncedAt: Date?
    private(set) var syncing = false
    /// Why the last fetch did not bring the newest copy (nil after a good one).
    private(set) var syncError: VaultSyncError?
    /// Items the vault key did not open (a damaged item): shown as a count, never hidden silently.
    private(set) var unreadable = 0

    private var vaultKey: Data?
    private var cache: VaultCacheFile?
    /// Moved by every lock and by forget: work that awaited across one (a Face ID prompt, a
    /// detached decrypt) drops its result instead of opening the list again.
    /// Moves on every lock, so a caller can tell one lock from the next.
    private(set) var lockEpoch = 0
    /// One Face ID question at a time: two locked screens (one under the other in a navigation
    /// stack) must not both ask.
    @ObservationIgnored private var biometricsInFlight = false
    /// Moved by forget alone: a fetch that was under way does not write the cache back.
    private var storeEpoch = 0
    private let serverProvider: () -> VaultServer?
    /// After every open of the items: the extension and the app keep iOS's AutoFill list current.
    var onItemsOpened: (([VaultItem]) -> Void)?

    /// A sign-in that fills a password and then a code opens two AutoFill sheets, each its own
    /// process, and each asked Face ID. After one unlock in a sheet, the key is kept this long in
    /// a Keychain item readable only on this iPhone and only while it is unlocked, and the next
    /// sheet in that time opens with it. 0, the app's, keeps none.
    var fillGraceSeconds: TimeInterval = 0

    init(server: @escaping () -> VaultServer?) {
        self.serverProvider = server
    }

    var vaultId: String? { cache?.header.id ?? header?.id }
    var secretKeyStored: Bool { vaultId.map { VaultKeychain.getPlain(account: VaultKeychain.secretKeyAccount($0)) != nil } ?? false }

    /// Read what is on this phone, with no network and no Face ID.
    func load() {
        cache = VaultCache.load()
        header = cache?.header
        syncedAt = cache?.syncedAt
        guard let c = cache, VaultKeychain.getPlain(account: VaultKeychain.secretKeyAccount(c.header.id)) != nil else {
            if phase != .unlocked { phase = .notSetUp }
            return
        }
        if phase == .unlocked { return }
        phase = VaultKeychain.hasGuarded(account: VaultKeychain.vaultKeyAccount(c.header.id))
            ? .locked : .needsPassword("Enter your master password to unlock Passwords on this iPhone.")
    }

    // MARK: - Fetching

    /// Bring the newest ciphertext from the Mac. Safe at any phase; while unlocked, the list
    /// is opened again from it.
    @discardableResult
    func sync() async -> Bool {
        guard !syncing else { return false }
        guard let server = serverProvider() else {
            syncError = .notPaired
            return false
        }
        syncing = true
        defer { syncing = false }
        let store = storeEpoch
        do {
            let client = VaultClient(server: server)
            let (h, tags) = try await client.index()
            let want = VaultCache.stale(cache, header: h, tags: tags)
            let fetched = want.isEmpty ? [:] : try await client.items(want)
            // Removed from this iPhone meanwhile: what came back is not kept.
            guard store == storeEpoch else { return false }
            let replaced = cache != nil && cache?.header.id != h.id
            var next = VaultCache.merged(cache, header: h, tags: tags, fetched: fetched, at: Date())
            if replaced {
                // Passwords were set up again on the Mac: another vault, another Secret Key. The old
                // vault's keys stay (under its own id, where nothing reads them) until this phone
                // opens the new one, so a reply that only claims a new vault removes nothing.
                next.keyWrapIV = nil
                cache = next
                try? VaultCache.save(next)
                header = h
                syncedAt = next.syncedAt
                syncError = nil
                vaultKey = nil
                items = []
                phase = .notSetUp
                return true
            }
            cache = next
            try? VaultCache.save(next)
            header = h
            syncedAt = next.syncedAt
            syncError = nil
            if phase == .unlocked, let vk = vaultKey {
                if next.keyWrapIV != nil, next.keyWrapIV != h.wrap.iv, await opens(vk, next) == false {
                    keyNoLongerOpens()
                } else {
                    await openAll(with: vk)
                }
            }
            return true
        } catch let e as VaultSyncError {
            syncError = e
            if e == .noVault, cache == nil { phase = .notSetUp }
            return false
        } catch {
            syncError = .network(error.localizedDescription)
            return false
        }
    }

    // MARK: - Setting up and unlocking

    enum SetUpError: Error, Equatable {
        /// A typed Secret Key with the password: either may be wrong.
        case wrongPassword
        /// The Secret Key came from this iPhone or the Mac: only the password can be wrong.
        case wrongMasterPassword
        case badSecretKey
        case secretKeyNeeded
        case weakKdf
        case other(String)

        var message: String {
            switch self {
            case .wrongPassword: return "That master password and Secret Key do not open your vault. Check both and try again."
            case .wrongMasterPassword: return "That is not your master password. Try again."
            case .badSecretKey: return "That is not a Secret Key. It starts with W1- and has 26 letters and digits after it."
            case .secretKeyNeeded: return "Enter your Secret Key too: this connection to your Mac is not private, so Walnut does not send it."
            case .weakKdf: return "Your Mac's vault uses a key setting this iPhone does not accept."
            case .other(let m): return m
            }
        }
    }

    /// Open the vault for the first time on this phone: the master password, and the Secret Key
    /// (typed, or read from the Mac over a private link when `secretKeyText` is empty).
    func setUp(password: String, secretKeyText: String) async throws {
        while syncing { try? await Task.sleep(nanoseconds: 100_000_000) }
        if cache == nil { await sync() }
        let epoch = lockEpoch
        guard let h = cache?.header ?? header else {
            throw SetUpError.other((syncError ?? .network("")).message)
        }
        let kdf = h.kdf
        do { try VaultCrypto.checkKdf(kdf) } catch { throw SetUpError.weakKdf }
        let pk = try await Task.detached(priority: .userInitiated) { try VaultCrypto.passwordKey(password, kdf: kdf) }.value
        var sk: Data
        let typed = secretKeyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty {
            guard let parsed = VaultCrypto.parseSecretKey(typed) else { throw SetUpError.badSecretKey }
            sk = parsed
        } else if let stored = VaultKeychain.getPlain(account: VaultKeychain.secretKeyAccount(h.id)) {
            sk = stored
        } else {
            guard let server = serverProvider() else { throw SetUpError.other(VaultSyncError.notPaired.message) }
            let client = VaultClient(server: server)
            guard server.transportIsPrivate, await client.privateLink() else { throw SetUpError.secretKeyNeeded }
            let text: String
            do { text = try await client.secretKey(passwordKey: pk) } catch let e as VaultSyncError {
                if case .server(401, _) = e { throw SetUpError.wrongMasterPassword }
                if case .server(429, let m) = e { throw SetUpError.other(m) }
                throw SetUpError.other(e.message)
            }
            guard let parsed = VaultCrypto.parseSecretKey(text) else { throw SetUpError.badSecretKey }
            sk = parsed
        }
        guard let salt = Data(base64Encoded: h.aukSalt) else { throw SetUpError.other("The vault header is damaged.") }
        let auk = VaultCrypto.unlockKey(passwordKey: pk, secretKey: sk, aukSalt: salt)
        let vk: Data
        do { vk = try VaultCrypto.open(key: auk, sealed: h.wrap, aad: VaultCrypto.aadWrap(h.id)) } catch {
            throw typed.isEmpty ? SetUpError.wrongMasterPassword : SetUpError.wrongPassword
        }
        do {
            try VaultKeychain.setPlain(sk, account: VaultKeychain.secretKeyAccount(h.id))
            try VaultKeychain.setGuarded(vk, account: VaultKeychain.vaultKeyAccount(h.id))
        } catch {
            throw SetUpError.other("This iPhone's Keychain did not take the key (\(error)).")
        }
        sk.resetBytes(in: 0..<sk.count)
        cache?.keyWrapIV = h.wrap.iv
        if let c = cache { try? VaultCache.save(c) }
        // Locked or removed while the key was being worked out: the key is kept, the list is not opened.
        guard epoch == lockEpoch else { return }
        vaultKey = vk
        keepForGrace(vk, vaultId: h.id)
        // The list is open before the phase says so: the AutoFill sheet fills the moment it reads
        // .unlocked, and an empty list would answer "not found".
        await openAll(with: vk)
        guard epoch == lockEpoch else { return }
        phase = .unlocked
    }

    /// The master password again (the Secret Key is already here).
    func unlock(password: String) async throws {
        try await setUp(password: password, secretKeyText: "")
    }

    /// `notNow`: iOS would not show Face ID yet (the AutoFill sheet still sliding in); asking again
    /// a moment later works.
    enum UnlockOutcome: Equatable { case unlocked, canceled, needsPassword, notNow }

    /// Face ID, then open the cached items.
    @discardableResult
    func unlockWithBiometrics(reason: String = "Unlock your Walnut passwords") async -> UnlockOutcome {
        guard let c = cache else { return .needsPassword }
        if await unlockFromGrace() { return .unlocked }
        guard !biometricsInFlight else { return .canceled }
        biometricsInFlight = true
        defer { biometricsInFlight = false }
        let epoch = lockEpoch
        let account = VaultKeychain.vaultKeyAccount(c.header.id)
        // Ask for Face ID first, then read the key with that answer: the Keychain's own guard
        // asks too on a phone, but not every simulator enforces it, and the person should always
        // see the prompt before anything opens. The read reuses this answer, so it is one prompt.
        let ctx = LAContext()
        var policyError: NSError?
        let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &policyError)
            ? .deviceOwnerAuthenticationWithBiometrics : .deviceOwnerAuthentication
        do {
            let ok = try await VaultSystemPrompt.shared.during { try await ctx.evaluatePolicy(policy, localizedReason: reason) }
            guard ok else { return .canceled }
        } catch let e as LAError where e.code == .userFallback {
            phase = .needsPassword("Enter your master password to unlock Passwords on this iPhone.")
            return .needsPassword
        } catch let e as LAError where [.biometryLockout, .biometryNotEnrolled, .biometryNotAvailable, .passcodeNotSet].contains(e.code) {
            phase = .needsPassword("Face ID is not available right now: enter your master password.")
            return .needsPassword
        } catch let e as LAError where [.systemCancel, .appCancel, .notInteractive].contains(e.code) {
            return .notNow
        } catch {
            return .canceled
        }
        guard epoch == lockEpoch else { return .canceled }
        let vk: Data
        do {
            vk = try await Task.detached(priority: .userInitiated) {
                try VaultKeychain.getGuarded(account: account, reason: reason, context: ctx)
            }.value
        } catch VaultKeychain.Failure.canceled {
            return .canceled
        } catch {
            phase = .needsPassword("Face ID changed or the key was removed: enter your master password.")
            return .needsPassword
        }
        if c.keyWrapIV != nil, c.keyWrapIV != c.header.wrap.iv, await opens(vk, c) == false {
            keyNoLongerOpens()
            return .needsPassword
        }
        guard epoch == lockEpoch else { return .canceled }
        vaultKey = vk
        keepForGrace(vk, vaultId: c.header.id)
        await openAll(with: vk)
        guard epoch == lockEpoch else { return .canceled }
        phase = .unlocked
        return .unlocked
    }

    private func keepForGrace(_ vk: Data, vaultId: String) {
        guard fillGraceSeconds > 0 else { return }
        let d = FillGrace.record(key: vk, until: Date().addingTimeInterval(fillGraceSeconds))
        try? VaultKeychain.setPlain(d, account: VaultKeychain.graceAccount(vaultId))
    }

    /// Opens with the key a sheet kept a moment ago, while it is still in time; one past its time
    /// (or one that no longer opens the vault) is removed.
    private func unlockFromGrace() async -> Bool {
        guard fillGraceSeconds > 0, phase == .locked, let c = cache else { return false }
        let account = VaultKeychain.graceAccount(c.header.id)
        guard let d = VaultKeychain.getPlain(account: account) else { return false }
        guard let vk = FillGrace.liveKey(d, grace: fillGraceSeconds) else {
            VaultKeychain.delete(account: account)
            return false
        }
        if await opens(vk, c) == false { VaultKeychain.delete(account: account); return false }
        let epoch = lockEpoch
        vaultKey = vk
        await openAll(with: vk)
        guard epoch == lockEpoch else { return false }
        phase = .unlocked
        return true
    }

    /// Ends a sheet's grace now (the person locked Passwords).
    func endFillGrace() {
        if let id = vaultId { VaultKeychain.delete(account: VaultKeychain.graceAccount(id)) }
    }

    /// A sheet cannot remove its key when its minute runs out (iOS has ended it by then), and the
    /// next sheet may be days away: the app removes a key past its time whenever it starts or
    /// comes to the front.
    func dropExpiredFillGrace() {
        guard let id = vaultId else { return }
        let account = VaultKeychain.graceAccount(id)
        guard let d = VaultKeychain.getPlain(account: account) else { return }
        // The app does not know the sheet's grace length: only the time written with it counts.
        if FillGrace.liveKey(d, grace: .greatestFiniteMagnitude) == nil { VaultKeychain.delete(account: account) }
    }

    func lock() {
        lockEpoch += 1
        vaultKey = nil
        items = []
        if phase == .unlocked { phase = .locked }
    }

    /// Remove everything Passwords keeps on this iPhone (the keys and the cached ciphertext).
    func forget() {
        lockEpoch += 1
        storeEpoch += 1
        VaultKeychain.deleteAll()
        VaultCache.delete()
        cache = nil
        header = nil
        syncedAt = nil
        vaultKey = nil
        items = []
        phase = .notSetUp
    }

    // MARK: - Opening

    private func keyNoLongerOpens() {
        if let id = vaultId { VaultKeychain.delete(account: VaultKeychain.vaultKeyAccount(id)) }
        vaultKey = nil
        items = []
        phase = .needsPassword("Your master password changed on your Mac. Enter the new one to unlock Passwords on this iPhone.")
    }

    /// Whether this vault key still opens the vault: true when any item opens, false when items
    /// are there and none does, nil with no item to tell by (asked again at the next fetch, since
    /// the wrap mark only moves at a set-up). One damaged item never removes a good key.
    private func opens(_ vk: Data, _ c: VaultCacheFile) async -> Bool? {
        if c.items.isEmpty { return nil }
        let vid = c.header.id
        let stored = c.items
        return await Task.detached {
            stored.contains { entry in (try? VaultCrypto.openItem(vaultKey: vk, vaultId: vid, id: entry.key, stored: entry.value)) != nil }
        }.value
    }

    private func openAll(with vk: Data) async {
        guard let c = cache else { items = []; return }
        let epoch = lockEpoch
        let vid = c.header.id
        let stored = c.items
        let (opened, bad) = await Task.detached(priority: .userInitiated) { () -> ([VaultItem], Int) in
            var out: [VaultItem] = []
            var bad = 0
            for (id, s) in stored {
                if let item = try? VaultCrypto.openItem(vaultKey: vk, vaultId: vid, id: id, stored: s) { out.append(item) } else { bad += 1 }
            }
            return (out, bad)
        }.value
        // Locked while it decrypted: no plaintext goes back on the model.
        guard epoch == lockEpoch else { return }
        unreadable = bad
        items = opened.filter { !$0.isTrashed }.sorted {
            let c = $0.title.localizedStandardCompare($1.title)
            return c == .orderedSame ? $0.id < $1.id : c == .orderedAscending
        }
        onItemsOpened?(items)
    }

    // MARK: - Finding

    /// Items whose title, username, sites, tags or notes hold every word of `query`.
    func search(_ query: String, in list: [VaultItem]? = nil) -> [VaultItem] {
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let base = list ?? items
        guard !words.isEmpty else { return base }
        return base.filter { item in
            let hay = ([item.title, item.username ?? "", item.notes ?? ""] + (item.urls ?? []) + (item.tags ?? [])).joined(separator: " ").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    /// Logins for the sites iOS names, best fit first, then the most recently used.
    func suggested(for hosts: [String]) -> [VaultItem] {
        guard !hosts.isEmpty else { return [] }
        var scored: [(item: VaultItem, score: Int)] = []
        for item in items where item.type == .login {
            let s = SiteMatch.score(item: item, pageHosts: hosts)
            if s > 0 { scored.append((item, s)) }
        }
        scored.sort { a, b in
            if a.score != b.score { return a.score > b.score }
            return (a.item.usedAt ?? "") > (b.item.usedAt ?? "")
        }
        return scored.map(\.item)
    }

}

/// The record a sheet keeps for the next one: the time it runs out (8 bytes) and the vault key.
enum FillGrace {
    static func record(key: Data, until: Date) -> Data {
        var d = withUnsafeBytes(of: until.timeIntervalSince1970.bitPattern.littleEndian) { Data($0) }
        d.append(key)
        return d
    }

    /// The key while the record is in time; nil past it, for a malformed one, or for a time
    /// further out than `grace` (no sheet of this build writes one).
    static func liveKey(_ d: Data, grace: TimeInterval, now: Date = Date()) -> Data? {
        guard d.count > 8 else { return nil }
        let bits = d.prefix(8).withUnsafeBytes { $0.loadUnaligned(as: UInt64.self) }
        let until = Date(timeIntervalSince1970: TimeInterval(bitPattern: UInt64(littleEndian: bits)))
        guard until > now, until.timeIntervalSince(now) <= grace + 1 else { return nil }
        return Data(d.dropFirst(8))
    }
}
