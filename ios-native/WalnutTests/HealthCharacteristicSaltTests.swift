import Security
import XCTest
@testable import Walnut

/// The characteristic salt in the real Keychain (r7b), under an account of its
/// own per test, so the installed app's items are never touched: how it is kept,
/// that it survives the process, and that it goes when asked.
final class HealthCharacteristicSaltTests: XCTestCase {
    private var account: String!

    override func setUp() {
        account = "walnut.health.characteristicSalt.test.\(UUID().uuidString)"
    }

    override func tearDown() {
        HealthCharacteristicSalt(account: account).delete()
    }

    func testTheSaltIsKeptOnThisDeviceOnlyAfterFirstUnlockAndNeverSynchronized() throws {
        let store = HealthCharacteristicSalt(account: account)
        XCTAssertEqual(store.read(), .missing)
        let salt = store.salt()
        XCTAssertEqual(salt.count, 32)
        XCTAssertEqual(store.read(), .found(salt), "the Keychain took it")

        let attributes = try XCTUnwrap(store.attributes())
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String,
                       kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        let synchronizable = attributes[kSecAttrSynchronizable as String]
        XCTAssertTrue(synchronizable == nil || (synchronizable as? NSNumber)?.boolValue == false,
                      "synchronizable: \(String(describing: synchronizable))")
        // No copy in the preferences, unlike the token's fallback.
        XCTAssertFalse(UserDefaults.standard.dictionaryRepresentation().keys.contains { $0.contains(account) })
    }

    func testTheSaltOutlivesTheProcessAndGoesWhenDeleted() {
        let first = HealthCharacteristicSalt(account: account).salt()
        // A new instance has nothing in memory: it reads the Keychain.
        XCTAssertEqual(HealthCharacteristicSalt(account: account).salt(), first)

        let store = HealthCharacteristicSalt(account: account)
        store.delete()
        XCTAssertEqual(store.read(), .missing)
        let second = store.salt()
        XCTAssertNotEqual(second, first, "a lost salt is a new salt")
        XCTAssertEqual(HealthCharacteristicSalt(account: account).salt(), second)
    }

    /// The two places it must go, and the one place it must never be.
    func testDisconnectAndAFreshInstallRemoveTheSalt() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        func source(_ path: String) throws -> String {
            try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
        }
        let background = try source("Walnut/Health/HealthBackground.swift")
        let erase = try XCTUnwrap(background.range(of: "static func eraseLocalState() {"))
        XCTAssertTrue(background[erase.upperBound...].prefix(300).contains("HealthCharacteristicSalt.shared.delete()"),
                      "Disconnect (LocalDataReset, through HealthSync.eraseLocalState) keeps the salt")
        XCTAssertTrue(try source("Walnut/Core/LocalDataReset.swift").contains("HealthSync.eraseLocalState()"))

        let marker = try source("Walnut/Core/InstallMarker.swift")
        XCTAssertTrue(marker.contains("removeLeftToken: () -> Void = { InstallMarker.removeKeychainItemsLeftByEarlierInstall() }"))
        let left = try XCTUnwrap(marker.range(of: "static func removeKeychainItemsLeftByEarlierInstall() {"))
        let body = marker[left.upperBound...].prefix(200)
        XCTAssertTrue(body.contains("AppConfig.removeTokenLeftByEarlierInstall()"))
        XCTAssertTrue(body.contains("HealthCharacteristicSalt.shared.delete()"))

        XCTAssertTrue(try source("Walnut/Health/HealthBackground.swift").contains("salt: HealthCharacteristicSalt.shared,"),
                      "the app's engine uses the Keychain salt")
        let state = try source("Walnut/Health/HealthSyncState.swift")
        XCTAssertFalse(state.contains("var characteristicSalt"), "the salt is back in the sync state file")
    }
}
