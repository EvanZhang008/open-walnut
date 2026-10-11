import Foundation

/// iOS keeps an app's Keychain items when the app is deleted, so the device
/// token would outlive a deleted Walnut, and a reinstall would find it. Its
/// preferences are deleted with it. So a marker in the preferences tells a first
/// launch after an install from every later one, and the first launch of a fresh
/// install removes what an earlier install left in the Keychain: the token, and
/// the Apple Health characteristic salt (`HealthCharacteristicSalt`).
///
/// An update keeps the token: the marker is new in this version, so a phone that
/// updates has no marker yet, but it has its server address, and that is how an
/// update is told from a fresh install. Nobody paired is logged out by an update.
///
/// The decision is never made on preferences that cannot be read. Before the
/// first unlock after a restart iOS cannot read the preferences file, and iOS
/// can launch Walnut then (Places, Apple Health), when the preferences would
/// look empty, like a fresh install. So it runs only while protected data is
/// available, reads the preferences file itself as a second witness, and does
/// nothing when either cannot be read: the next launch decides.
enum InstallMarker {
    static let key = "walnut.installMarker"

    enum Outcome: String, Equatable {
        /// No marker and no pairing: a fresh install. The left token was removed.
        case freshInstall
        /// No marker, but a server address: an update. The token stays.
        case upgrade
        /// The marker is there: an ordinary launch. Nothing to do.
        case relaunch
        /// The preferences could not be read. Nothing was changed.
        case notNow
    }

    /// The preferences file as read from disk, not through `UserDefaults`.
    enum FileView {
        case absent
        case unreadable
        case contents([String: Any])
    }

    /// `persistent` is the app's persistent domain only. Launch arguments live
    /// in another domain: `-walnut.serverUrl` on a test launch must not read as
    /// a pairing, and the plain `string(forKey:)` would see it.
    static func decide(persistent: [String: Any]?, file: FileView, protectedDataAvailable: Bool) -> Outcome {
        guard protectedDataAvailable else { return .notNow }
        let prefs = persistent ?? [:]
        if prefs[key] != nil { return .relaunch }
        if prefs[AppConfig.urlKey] != nil { return .upgrade }
        switch file {
        case .unreadable:
            return .notNow
        case .contents(let onDisk):
            if onDisk[key] != nil { return .relaunch }
            if onDisk[AppConfig.urlKey] != nil { return .upgrade }
            return .freshInstall
        case .absent:
            return .freshInstall
        }
    }

    /// Decide, then act: a fresh install loses the left token, and both a fresh
    /// install and an update get the marker.
    @discardableResult
    static func reconcile(
        defaults: UserDefaults = .standard,
        domain: String? = Bundle.main.bundleIdentifier,
        file: () -> FileView = { InstallMarker.preferencesFile() },
        protectedDataAvailable: Bool,
        removeLeftToken: () -> Void = { InstallMarker.removeKeychainItemsLeftByEarlierInstall() }
    ) -> Outcome {
        let persistent = domain.flatMap { defaults.persistentDomain(forName: $0) }
        let outcome = decide(persistent: persistent, file: file(), protectedDataAvailable: protectedDataAvailable)
        switch outcome {
        case .freshInstall:
            removeLeftToken()
            defaults.set(true, forKey: key)
        case .upgrade:
            defaults.set(true, forKey: key)
        case .relaunch, .notNow:
            break
        }
        return outcome
    }

    /// A fresh install: the token and the characteristic salt an earlier install
    /// left in the Keychain go. A new salt is made the first time Health syncs.
    static func removeKeychainItemsLeftByEarlierInstall() {
        AppConfig.removeTokenLeftByEarlierInstall()
        HealthCharacteristicSalt.shared.delete()
    }

    /// The app's own preferences file, `Library/Preferences/<bundle id>.plist`.
    static func preferencesFile(bundleID: String? = Bundle.main.bundleIdentifier) -> FileView {
        guard let bundleID else { return .unreadable }
        let url = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Preferences/\(bundleID).plist")
        guard FileManager.default.fileExists(atPath: url.path) else { return .absent }
        guard let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return .unreadable }
        return .contents(plist)
    }

    /// The hosted unit-test bundle runs inside the installed app: it must not
    /// change that app's pairing.
    static var isHostedUnitTestProcess: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }
}
