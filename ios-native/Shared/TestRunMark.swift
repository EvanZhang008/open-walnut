import Foundation

/// An app under automation says so on every request it makes to Walnut (`x-walnut-test-run`),
/// the way the web app does under `navigator.webdriver` (web/src/api/test-run.ts). On the
/// user's own Walnut every task and project such a request creates is then a test object: off
/// the user's board, Org and counts, never read as the user's words, and swept once idle
/// (src/core/test-run.ts). The app still sees them, since the server hands them to a test run
/// unmarked.
///
/// 2026-11-09: an acceptance run drove the phone app with Maestro against the live server; the
/// message it queued was recorded as the user's own words, and Walnut reported the test task
/// as "the user is talking with it in its own chat".
///
/// Under automation means, read once per process from its launch (the argument domain only,
/// never the stored pairing):
/// - `-walnut.testRun <label>` names the run; `0`, `false` or empty turns marking off, the
///   other signs too (a demo recorded for the user is real work);
/// - `WALNUT_TEST_RUN=<label>` in the environment, as for the `walnut` CLI;
/// - a hosted unit-test process (`XCTestConfigurationFilePath`);
/// - an app launched by a UI test or a Maestro flow: `-walnut.uiTestKeychain YES`,
///   `-walnut.silentAudio YES`, or a pairing passed on the command line (`-walnut.deviceToken`,
///   a token minted for a test, or `-walnut.serverUrl`);
/// - any launch in the Simulator, as for `AudioSilence`: the user's own app runs on a phone,
///   and a Maestro flow, a robot or a monkey run often launches a simulator already paired
///   (`defaults write`) with no argument at all.
///
/// A label found this way names this install too (`ios-uitest-k3f9a2`, an id kept in its
/// defaults), so the layout one run writes stays that run's (src/core/test-run-prefs.ts), as the
/// web app's names its browser context.
///
/// Every request to Walnut goes through `authorizeForWalnut(token:)` or `markTestRun()`; the
/// ratchet is tests/web/ios-test-run-mark-guard.test.ts.
enum TestRunMark {
    static let header = "x-walnut-test-run"
    static let argument = "walnut.testRun"

    /// This process's label, or nil for a person's app.
    static let label: String? = decide(
        arguments: UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain),
        environment: ProcessInfo.processInfo.environment,
        simulator: runsInSimulator,
        install: { installID(UserDefaults.standard) }
    )

    private static let installKey = "walnut.testRunInstall"

    /// Launch signs of automation, in the order their label is chosen.
    private static let flags: [(key: String, label: String)] = [
        ("walnut.uiTestKeychain", "ios-uitest"),
        ("walnut.silentAudio", "ios-silent-audio"),
    ]
    private static let pairings: [(key: String, label: String)] = [
        ("walnut.deviceToken", "ios-launch-token"),
        ("walnut.serverUrl", "ios-launch-server"),
    ]

    /// Pure: the label for a launch, given its argument domain, environment, whether it runs in
    /// the Simulator, and this install's id (read only when a sign is found).
    static func decide(
        arguments: [String: Any], environment: [String: String], simulator: Bool, install: () -> String?
    ) -> String? {
        if let asked = arguments[argument] { return clean("\(asked)") }
        if let named = environment["WALNUT_TEST_RUN"] { return clean(named) }
        guard let sign = sign(arguments: arguments, environment: environment, simulator: simulator) else { return nil }
        // A hosted unit-test process talks to no server (AppConfig's blackhole) and keeps no id.
        if sign == "ios-xctest" { return sign }
        guard let id = install(), !id.isEmpty else { return sign }
        return "\(sign)-\(id)"
    }

    private static func sign(arguments: [String: Any], environment: [String: String], simulator: Bool) -> String? {
        if environment["XCTestConfigurationFilePath"] != nil { return "ios-xctest" }
        for flag in flags where isOn(arguments[flag.key]) { return flag.label }
        for pairing in pairings {
            if let value = arguments[pairing.key] as? String, !value.isEmpty { return pairing.label }
        }
        return simulator ? "ios-simulator" : nil
    }

    /// This install's id: made once and kept in its defaults (a fresh install, or a Maestro
    /// `clearState`, makes a new one).
    static func installID(_ defaults: UserDefaults) -> String {
        if let id = defaults.string(forKey: installKey), id.range(of: "^[a-z0-9]{6}$", options: .regularExpression) != nil {
            return id
        }
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        let id = String((0..<6).map { _ in alphabet.randomElement()! })
        defaults.set(id, forKey: installKey)
        return id
    }

    /// The headers an AVURLAsset sends to Walnut: the device token and this run's label.
    static func headers(token: String) -> [String: String] {
        var headers = ["Authorization": "Bearer \(token)"]
        if let label { headers[header] = label }
        return headers
    }

    /// A header-safe label of at most 60 printable characters, nil for off (the server's
    /// parseTestRunLabel).
    static func clean(_ raw: String) -> String? {
        let printable = String(raw.unicodeScalars.filter { $0.value >= 0x20 && $0.value <= 0x7e })
        let trimmed = String(printable.trimmingCharacters(in: .whitespaces).prefix(60))
        if trimmed.isEmpty || trimmed == "0" || trimmed.lowercased() == "false" { return nil }
        return trimmed
    }

    static var runsInSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    private static func isOn(_ value: Any?) -> Bool {
        if let flag = value as? Bool { return flag }
        if let number = value as? NSNumber { return number.boolValue }
        guard let text = value as? String else { return false }
        return ["yes", "true", "1"].contains(text.lowercased())
    }
}

extension URLRequest {
    /// Authorizes a request to Walnut with the device token (none for a nil or empty one: a
    /// probe before pairing), and marks it when this app runs under automation (`TestRunMark`).
    mutating func authorizeForWalnut(token: String?) {
        if let token, !token.isEmpty { setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        markTestRun()
    }

    /// Marks a request to Walnut that carries no token (the identity probe of an address)
    /// when this app runs under automation.
    mutating func markTestRun() {
        if let label = TestRunMark.label { setValue(label, forHTTPHeaderField: TestRunMark.header) }
    }
}
