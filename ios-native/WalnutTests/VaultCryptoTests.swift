import CryptoKit
import XCTest
@testable import Walnut

/// The iPhone opens the vault the server sealed (Shared/Vault, docs/reference/passwords.md
/// "iPhone"): a fixture sealed by the server's own code (scripts/ios-vault-fixture.ts), opened
/// here with the master password and the Secret Key; one-time codes, site matching, passkey
/// signatures, the cache merge and the identities iOS is given.
final class VaultCryptoTests: XCTestCase {
    struct Fixture: Decodable {
        struct Expected: Decodable {
            struct Code: Decodable { var at: Double; var code: String; var remaining: Int }
            struct Passkey: Decodable { var itemTitle: String; var credentialId: String; var publicKeySpki: String; var userHandle: String }
            var vaultKey: String
            var titles: [String]
            var totp: Code
            var passkey: Passkey
        }
        var master: String
        var secretKey: String
        var header: VaultHeader
        var items: [String: VaultStoredItem]
        var expected: Expected
    }

    static let fixture: Fixture = {
        let url = Bundle(for: VaultCryptoTests.self).url(forResource: "vault-fixture", withExtension: "json")!
        return try! JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }()

    private func openAll(_ f: Fixture, vk: Data) throws -> [VaultItem] {
        try f.items.map { try VaultCrypto.openItem(vaultKey: vk, vaultId: f.header.id, id: $0.key, stored: $0.value) }
    }

    func testOpensTheServersVaultWithTheMasterPasswordAndSecretKey() throws {
        let f = Self.fixture
        XCTAssertTrue(f.header.supported)
        XCTAssertEqual(f.header.hint, "a fixture hint")
        let sk = try XCTUnwrap(VaultCrypto.parseSecretKey(f.secretKey))
        let vk = try VaultCrypto.vaultKey(password: f.master, secretKey: sk, header: f.header)
        XCTAssertEqual(vk.base64EncodedString(), f.expected.vaultKey)
        let items = try openAll(f, vk: vk)
        XCTAssertEqual(Set(items.map(\.title)), Set(f.expected.titles))
        let mail = try XCTUnwrap(items.first { $0.title == "Example Mail" })
        XCTAssertEqual(mail.username, "alice@example.test")
        XCTAssertEqual(mail.password, "Fixture-Pass-1!")
        XCTAssertEqual(mail.hosts, ["mail.example.test"])
        XCTAssertEqual(items.first { $0.title == "Caf\u{e9} wifi" }?.notes, "router \u{e9}t\u{e9} \u{1F511}")
        XCTAssertTrue(try XCTUnwrap(items.first { $0.title == "Old Login" }).isTrashed)
    }

    func testTheWrongPasswordOrSecretKeyOpensNothing() throws {
        let f = Self.fixture
        let sk = try XCTUnwrap(VaultCrypto.parseSecretKey(f.secretKey))
        XCTAssertThrowsError(try VaultCrypto.vaultKey(password: f.master + "x", secretKey: sk, header: f.header))
        var other = sk
        other[0] ^= 1
        XCTAssertThrowsError(try VaultCrypto.vaultKey(password: f.master, secretKey: other, header: f.header))
        // The NFKC form of the password is what counts, as in WebCrypto.
        XCTAssertNoThrow(try VaultCrypto.vaultKey(password: f.master.decomposedStringWithCanonicalMapping, secretKey: sk, header: f.header))
    }

    func testAnItemMovedUnderAnotherIdDoesNotOpen() throws {
        let f = Self.fixture
        let vk = try XCTUnwrap(Data(base64Encoded: f.expected.vaultKey))
        let ids = Array(f.items.keys)
        XCTAssertThrowsError(try VaultCrypto.openItem(vaultKey: vk, vaultId: f.header.id, id: ids[0], stored: f.items[ids[1]]!))
        XCTAssertThrowsError(try VaultCrypto.openItem(vaultKey: vk, vaultId: "another-vault", id: ids[0], stored: f.items[ids[0]]!))
    }

    func testRefusesAWeakOrUnknownKdf() {
        var kdf = Self.fixture.header.kdf
        kdf.iterations = 1000
        XCTAssertThrowsError(try VaultCrypto.passwordKey("x", kdf: kdf)) { XCTAssertEqual($0 as? VaultCrypto.Failure, .weakKdf) }
        kdf = Self.fixture.header.kdf
        kdf.salt = Data(count: 8).base64EncodedString()
        XCTAssertThrowsError(try VaultCrypto.passwordKey("x", kdf: kdf)) { XCTAssertEqual($0 as? VaultCrypto.Failure, .weakKdf) }
        kdf = Self.fixture.header.kdf
        kdf.name = "argon2id"
        XCTAssertThrowsError(try VaultCrypto.passwordKey("x", kdf: kdf))
    }

    func testANewerVaultFormatIsNotOpened() {
        var h = Self.fixture.header
        h.version = 2
        XCTAssertFalse(h.supported)
        h.version = 1
        h.format = "other"
        XCTAssertFalse(h.supported)
    }

    func testSecretKeyTextRoundTripsAndRejectsBadInput() throws {
        let sk = try XCTUnwrap(VaultCrypto.parseSecretKey(Self.fixture.secretKey))
        XCTAssertEqual(sk.count, 16)
        XCTAssertEqual(VaultCrypto.secretKeyText(sk), Self.fixture.secretKey)
        // Case, spaces and dashes (a pasted en dash too) are free.
        let messy = " " + Self.fixture.secretKey.lowercased().replacingOccurrences(of: "-", with: " \u{2013} ") + "\n"
        XCTAssertEqual(VaultCrypto.parseSecretKey(messy), sk)
        XCTAssertNil(VaultCrypto.parseSecretKey("R1-" + Self.fixture.secretKey.dropFirst(3)))
        XCTAssertNil(VaultCrypto.parseSecretKey("W1-ABC"))
        XCTAssertNil(VaultCrypto.parseSecretKey("W1-IIIIII-IIIII-IIIII-IIIII-IIIII"))
        // 26 digits hold 130 bits: a value over 128 bits is not a key.
        XCTAssertNil(VaultCrypto.parseSecretKey("W1-999999-99999-99999-99999-99999"))
    }

    func testTotpMatchesTheServer() throws {
        let f = Self.fixture
        let vk = try XCTUnwrap(Data(base64Encoded: f.expected.vaultKey))
        let mail = try XCTUnwrap(try openAll(f, vk: vk).first { $0.title == "Example Mail" })
        let t = try XCTUnwrap(TOTP.parse(mail.totp ?? ""))
        XCTAssertEqual(t.issuer, "Example")
        XCTAssertEqual(t.account, "alice")
        let c = t.code(at: Date(timeIntervalSince1970: f.expected.totp.at))
        XCTAssertEqual(c.code, f.expected.totp.code)
        XCTAssertEqual(c.remaining, f.expected.totp.remaining)
        // RFC 6238 test vector (SHA-1, 8 digits, T = 59).
        let rfc = TOTP(secret: Data("12345678901234567890".utf8), digits: 8, period: 30, algorithm: .sha1)
        XCTAssertEqual(rfc.code(at: Date(timeIntervalSince1970: 59)).code, "94287082")
        XCTAssertNil(TOTP.parse("not base32 !!"))
        XCTAssertNil(TOTP.parse("otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP"))
        XCTAssertNotNil(TOTP.parse("jbsw y3dp ehpk 3pxp"))
    }

    func testSiteMatchingNeverJoinsSiblingsUnderASharedSuffix() {
        XCTAssertEqual(SiteMatch.host(of: "https://WWW.Example.com/login?x=1"), "example.com")
        XCTAssertEqual(SiteMatch.host(of: "example.com"), "example.com")
        XCTAssertEqual(SiteMatch.score(saved: "example.com", page: "example.com"), 2)
        XCTAssertEqual(SiteMatch.score(saved: "example.com", page: "accounts.example.com"), 1)
        XCTAssertEqual(SiteMatch.score(saved: "accounts.example.com", page: "example.com"), 1)
        XCTAssertEqual(SiteMatch.score(saved: "mail.example.com", page: "accounts.example.com"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "alice.github.io", page: "bob.github.io"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "github.io", page: "bob.github.io"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "co.uk", page: "shop.co.uk"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "com", page: "example.com"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "example.com", page: "example.com.evil.test"), 0)
        XCTAssertEqual(SiteMatch.score(saved: "example.com", page: "notexample.com"), 0)
    }

    func testPasskeyAssertionVerifiesWithTheStoredPublicKey() throws {
        let f = Self.fixture
        let vk = try XCTUnwrap(Data(base64Encoded: f.expected.vaultKey))
        let item = try XCTUnwrap(try openAll(f, vk: vk).first { $0.title == f.expected.passkey.itemTitle })
        let pk = try XCTUnwrap(item.passkeys?.first)
        XCTAssertTrue(PasskeySigner.canSign(pk))
        let hash = Data(SHA256.hash(data: Data("{\"type\":\"webauthn.get\"}".utf8)))
        let a = try XCTUnwrap(PasskeySigner.assert(pk, rpId: "Passkeys.Example.Test", clientDataHash: hash))
        XCTAssertNil(PasskeySigner.assert(pk, rpId: "other.example.test", clientDataHash: hash))
        XCTAssertEqual(a.authenticatorData.prefix(32), Data(SHA256.hash(data: Data("passkeys.example.test".utf8))))
        XCTAssertEqual(a.authenticatorData[32], 0x1D)
        XCTAssertEqual(Array(a.authenticatorData.suffix(4)), [0, 0, 0, 0])
        XCTAssertEqual(a.credentialID, PasskeySigner.credentialIdBytes(f.expected.passkey.credentialId))
        XCTAssertEqual(a.credentialID.count, 16)
        XCTAssertEqual(a.userHandle, PasskeySigner.base64URLDecode(f.expected.passkey.userHandle))
        let pub = try P256.Signing.PublicKey(derRepresentation: XCTUnwrap(Data(base64Encoded: f.expected.passkey.publicKeySpki)))
        let sig = try P256.Signing.ECDSASignature(derRepresentation: a.signature)
        XCTAssertTrue(pub.isValidSignature(sig, for: a.authenticatorData + hash))
    }

    func testPasskeyCounterNeverRepeatsOnThisPhone() throws {
        let f = Self.fixture
        let vk = try XCTUnwrap(Data(base64Encoded: f.expected.vaultKey))
        let item = try XCTUnwrap(try openAll(f, vk: vk).first { $0.title == f.expected.passkey.itemTitle })
        let synced = try XCTUnwrap(item.passkeys?.first)
        let suite = "walnut.tests.passkeyCounter.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let hash = Data(SHA256.hash(data: Data("{}".utf8)))
        func sent(_ pk: VaultPasskey) throws -> [UInt8] {
            Array(try XCTUnwrap(PasskeySigner.assert(pk, rpId: "passkeys.example.test", clientDataHash: hash, counters: defaults)).authenticatorData.suffix(4))
        }
        // A synced passkey (counter 0) never counts.
        XCTAssertEqual(try sent(synced), [0, 0, 0, 0])
        XCTAssertEqual(try sent(synced), [0, 0, 0, 0])
        // One that counts goes up on every use here, though the vault still says 5.
        var counting = synced
        counting.values["counter"] = "5"
        XCTAssertEqual(try sent(counting), [0, 0, 0, 6])
        XCTAssertEqual(try sent(counting), [0, 0, 0, 7])
        // The Mac counting further (a use there) wins.
        counting.values["counter"] = "20"
        XCTAssertEqual(try sent(counting), [0, 0, 0, 21])
    }

    func testCredentialIdForms() {
        XCTAssertEqual(PasskeySigner.credentialIdBytes("00112233-4455-6677-8899-aabbccddeeff")?.count, 16)
        XCTAssertEqual(PasskeySigner.credentialIdBytes("b64.AQID"), Data([1, 2, 3]))
        XCTAssertNil(PasskeySigner.credentialIdBytes("b64."))
        XCTAssertNil(PasskeySigner.credentialIdBytes("plain"))
        XCTAssertEqual(CredentialIdentities.parse(record: "item-1#pk:b64.AQID").item, "item-1")
        XCTAssertEqual(CredentialIdentities.parse(record: "item-1#pk:b64.AQID").passkey, "b64.AQID")
        XCTAssertNil(CredentialIdentities.parse(record: "item-1").passkey)
    }

    func testIdentitiesHoldNoSecretAndSkipTheTrash() throws {
        let f = Self.fixture
        let vk = try XCTUnwrap(Data(base64Encoded: f.expected.vaultKey))
        let ids = CredentialIdentities.identities(for: try openAll(f, vk: vk))
        // One password and one code for Example Mail, one passkey; nothing for the note or the trash.
        XCTAssertEqual(ids.count, 3)
        let described = ids.map { "\($0.serviceIdentifier.identifier)|\($0.user)" }.joined(separator: ",")
        XCTAssertFalse(described.contains("Fixture-Pass-1!"))
        XCTAssertFalse(described.contains("old.example.test"))
        XCTAssertTrue(described.contains("mail.example.test|alice@example.test"))
        XCTAssertTrue(described.contains("passkeys.example.test|bob"))
    }

    func testCacheMergeKeepsUnchangedItemsAndDropsRemovedOnes() {
        let f = Self.fixture
        let ids = f.items.keys.sorted()
        let tags = Dictionary(uniqueKeysWithValues: ids.map { ($0, "t-\($0)") })
        let first = VaultCache.merged(nil, header: f.header, tags: tags, fetched: f.items, at: Date())
        XCTAssertEqual(first.items.count, ids.count)
        XCTAssertEqual(VaultCache.stale(first, header: f.header, tags: tags), [])
        // One changed on the Mac, one removed.
        var next = tags
        next[ids[0]] = "t-new"
        next.removeValue(forKey: ids[1])
        XCTAssertEqual(VaultCache.stale(first, header: f.header, tags: next), [ids[0]])
        let second = VaultCache.merged(first, header: f.header, tags: next, fetched: [ids[0]: f.items[ids[0]]!], at: Date())
        XCTAssertEqual(Set(second.items.keys), Set(next.keys))
        XCTAssertNil(second.items[ids[1]])
        // Another vault (set up again on the Mac): everything is fetched again.
        var other = f.header
        other.id = "another"
        XCTAssertEqual(VaultCache.stale(second, header: other, tags: next).count, next.count)
    }

    func testTheExtensionCarriesTheAppsVersionAndBuildNumber() throws {
        let app = Bundle.main
        let appex = try XCTUnwrap(app.builtInPlugInsURL?.appendingPathComponent("WalnutAutoFill.appex"))
        let ext = try XCTUnwrap(Bundle(url: appex))
        XCTAssertEqual(ext.object(forInfoDictionaryKey: "CFBundleVersion") as? String, app.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
        XCTAssertEqual(ext.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, app.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
    }

    /// A person who never typed a Secret Key (the Mac sent it, or this iPhone keeps it) is never
    /// told to check one: only the password can be wrong then.
    @MainActor
    func testAWrongPasswordNamesOnlyWhatThePersonTyped() {
        XCTAssertFalse(VaultModel.SetUpError.wrongMasterPassword.message.contains("Secret Key"))
        XCTAssertTrue(VaultModel.SetUpError.wrongPassword.message.contains("Secret Key"))
    }

    func testALoginPickedForAnotherSiteAsksFirst() throws {
        func item(_ urls: [String]) throws -> VaultItem {
            let json = try JSONSerialization.data(withJSONObject: ["id": "i1", "type": "login", "title": "T", "urls": urls])
            return try JSONDecoder().decode(VaultItem.self, from: json)
        }
        let local = try item(["http://localhost:8765/login.html"])
        XCTAssertFalse(AutoFillCrossSite.needsConfirm(item: local, hosts: ["localhost"]))
        XCTAssertTrue(AutoFillCrossSite.needsConfirm(item: local, hosts: ["127.0.0.1"]))
        XCTAssertTrue(AutoFillCrossSite.needsConfirm(item: try item([]), hosts: ["127.0.0.1"]))
        // An app that names no site has nothing to compare against.
        XCTAssertFalse(AutoFillCrossSite.needsConfirm(item: local, hosts: []))
        XCTAssertEqual(AutoFillCrossSite.title(local, hosts: ["127.0.0.1"]), "This login is saved for localhost, not 127.0.0.1")
    }

    func testSimilarSitesRankThePickerOnly() {
        XCTAssertTrue(SiteMatch.similar(saved: "localhost", page: "127.0.0.1"))
        XCTAssertTrue(SiteMatch.similar(saved: "example.com", page: "example.org"))
        XCTAssertTrue(SiteMatch.similar(saved: "app.example.com", page: "login.example.org"))
        XCTAssertFalse(SiteMatch.similar(saved: "github.com", page: "127.0.0.1"))
        XCTAssertFalse(SiteMatch.similar(saved: "github.com", page: "gitlab.com"))
        XCTAssertFalse(SiteMatch.similar(saved: "router", page: "127.0.0.1"))
    }

    func testAFillGraceKeyOpensOnlyInItsMinute() {
        let key = Data(repeating: 7, count: 32)
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let rec = FillGrace.record(key: key, until: now.addingTimeInterval(60))
        XCTAssertEqual(FillGrace.liveKey(rec, grace: 60, now: now), key)
        XCTAssertEqual(FillGrace.liveKey(rec, grace: 60, now: now.addingTimeInterval(59)), key)
        XCTAssertNil(FillGrace.liveKey(rec, grace: 60, now: now.addingTimeInterval(60)), "past its minute")
        // A record claiming more time than the sheet gives is not trusted.
        let far = FillGrace.record(key: key, until: now.addingTimeInterval(3600))
        XCTAssertNil(FillGrace.liveKey(far, grace: 60, now: now))
        XCTAssertNil(FillGrace.liveKey(Data([1, 2, 3]), grace: 60, now: now), "malformed")
        // The app's sweep keeps a record still in time and drops one past it.
        XCTAssertNotNil(FillGrace.liveKey(rec, grace: .greatestFiniteMagnitude, now: now))
        XCTAssertNil(FillGrace.liveKey(rec, grace: .greatestFiniteMagnitude, now: now.addingTimeInterval(61)))
    }

    /// Lock holds back the automatic Face ID for that one lock only: the next lock (time away,
    /// the phone locking) asks again.
    @MainActor
    func testAHandLockCoversOnlyItsOwnLock() {
        let store = PasswordsStore.shared
        store.lockByHand()
        XCTAssertTrue(store.lockedByHand)
        store.model.lock()   // what coming back after two minutes away does
        XCTAssertFalse(store.lockedByHand)
        store.lockByHand()
        store.clearLockedByHand()
        XCTAssertFalse(store.lockedByHand)
    }
}
