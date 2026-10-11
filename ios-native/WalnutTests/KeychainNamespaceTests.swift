import Security
import XCTest

@testable import Walnut

/// A TEST NEVER TOUCHES THE REAL DEVICE TOKEN.
///
/// The Keychain belongs to the simulator, not to the app container a test stage backs up
/// and restores. `DemoModeUITests` paired the demo through `ConnectionStore.connect`
/// (writing its token over the real `walnut.deviceToken`) and left it through "Leave demo"
/// (deleting it), so the shared simulator lost its real pairing on every run (2026-10-11).
/// In a DEBUG build `KeychainHelper` now keeps a test process under names of its own: a
/// hosted unit-test process by its `XCTestConfigurationFilePath`, an app under XCUITest by
/// the launch argument `UITestLaunch` passes on every launch.
final class KeychainNamespaceTests: XCTestCase {

    private let realService = "dev.openwalnut.ios"
    private let realPrefix = "walnut.keychainFallback."

    // MARK: - The names

    /// The real names are the ones every shipped build has used: changing either would
    /// sign every installed app out.
    func testTheRealNamespaceKeepsTheShippedNames() {
        XCTAssertEqual(KeychainHelper.Namespace.real.service, realService)
        XCTAssertEqual(KeychainHelper.Namespace.real.fallbackPrefix, realPrefix)
    }

    func testTheTestNamespaceSharesNoNameWithTheRealOne() {
        let real = KeychainHelper.Namespace.real
        let tests = KeychainHelper.Namespace.tests
        XCTAssertNotEqual(tests.service, real.service)
        XCTAssertNotEqual(tests.fallbackPrefix, real.fallbackPrefix)
        // A prefix of the other would let one store's keys read as the other's.
        XCTAssertFalse(tests.fallbackPrefix.hasPrefix(real.fallbackPrefix))
        XCTAssertFalse(real.fallbackPrefix.hasPrefix(tests.fallbackPrefix))
    }

    // MARK: - The switch

    func testAPlainLaunchUsesTheRealNamespace() throws {
        let defaults = try scratchDefaults()
        XCTAssertEqual(KeychainHelper.Namespace.resolve(environment: [:], defaults: defaults), .real)
    }

    func testAHostedTestProcessUsesTheTestNamespace() throws {
        let defaults = try scratchDefaults()
        let env = ["XCTestConfigurationFilePath": "/tmp/Walnut.xctestconfiguration"]
        XCTAssertEqual(KeychainHelper.Namespace.resolve(environment: env, defaults: defaults), .tests)
    }

    func testTheUITestLaunchArgumentUsesTheTestNamespace() throws {
        let defaults = try scratchDefaults()
        defaults.set(true, forKey: KeychainHelper.Namespace.uiTestArgument)
        XCTAssertEqual(KeychainHelper.Namespace.resolve(environment: [:], defaults: defaults), .tests)
        defaults.set(false, forKey: KeychainHelper.Namespace.uiTestArgument)
        XCTAssertEqual(KeychainHelper.Namespace.resolve(environment: [:], defaults: defaults), .real)
    }

    /// This very process is hosted by xcodebuild, so every other unit test stores under
    /// the test names too.
    func testThisProcessStoresUnderTheTestNamespace() {
        XCTAssertEqual(KeychainHelper.namespace, .tests)
        XCTAssertEqual(KeychainHelper.fallbackPrefix, KeychainHelper.Namespace.tests.fallbackPrefix)
    }

    // MARK: - The real item

    /// A write, read and delete through the helper reach neither the real Keychain item
    /// nor the real fallback key, whatever either holds before.
    func testWritingAndDeletingLeaveTheRealItemAlone() {
        let account = "walnut.keychainNamespaceTests.\(UUID().uuidString)"
        let sentinel = "real-\(UUID().uuidString)"
        XCTAssertEqual(addRealItem(sentinel, account: account), errSecSuccess)
        UserDefaults.standard.set(sentinel, forKey: realPrefix + account)
        defer {
            deleteRealItem(account: account)
            UserDefaults.standard.removeObject(forKey: realPrefix + account)
            KeychainHelper.delete(account)
        }

        XCTAssertNil(KeychainHelper.get(account), "the helper read the real store")
        KeychainHelper.set("test-token", forKey: account)
        XCTAssertEqual(KeychainHelper.get(account), "test-token")
        XCTAssertEqual(realItem(account: account), sentinel, "the write replaced the real item")

        KeychainHelper.delete(account)
        XCTAssertNil(KeychainHelper.get(account))
        XCTAssertEqual(realItem(account: account), sentinel, "the delete removed the real item")
        XCTAssertEqual(UserDefaults.standard.string(forKey: realPrefix + account), sentinel)
    }

    // MARK: - Every UI test launch passes the argument

    func testEveryUITestLaunchPassesTheKeychainArgument() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()      // WalnutTests/
            .deletingLastPathComponent()      // ios-native/
        let source = try String(
            contentsOf: root.appendingPathComponent("WalnutUITests/UITestLaunch.swift"), encoding: .utf8)
        XCTAssertTrue(
            source.contains("\"-\(KeychainHelper.Namespace.uiTestArgument)\", \"YES\""),
            "UITestLaunch no longer names the Keychain argument")
        XCTAssertTrue(
            source.contains("+ keychainArguments +"),
            "UITestLaunch.app no longer adds the Keychain argument to every launch")
    }

    // MARK: - Helpers

    private func scratchDefaults() throws -> UserDefaults {
        let name = "KeychainNamespaceTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        return defaults
    }

    private func realQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: realService,
            kSecAttrAccount as String: account,
        ]
    }

    private func addRealItem(_ value: String, account: String) -> OSStatus {
        var attributes = realQuery(account: account)
        attributes[kSecValueData as String] = Data(value.utf8)
        return SecItemAdd(attributes as CFDictionary, nil)
    }

    private func realItem(account: String) -> String? {
        var query = realQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteRealItem(account: String) {
        SecItemDelete(realQuery(account: account) as CFDictionary)
    }
}
