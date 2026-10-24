import Foundation

// The Mac app's own update, the flow T3 Code ships (apps/desktop/src/updates in
// pingdotgg/t3code, electron-updater underneath): a quiet check 15 s after launch
// and every 4 minutes, the user downloads from the rail's update item, and a
// downloaded update installs on "Restart to update". This file is the part that
// decides: the state and its reducers (a port of T3's updateMachine.ts, same
// statuses and fields, so the web side's logic ports over unchanged), which
// release to fetch, why updates are off in this copy, and whether a relaunched
// app installs the Walnut it carries. AppUpdater.swift does the I/O.
//
// Foundation only, so tests/desktop/app-update-tests.swift compiles it alone.

enum AppUpdateStatus: String, Codable {
    case disabled, idle, checking
    case upToDate = "up-to-date"
    case available, downloading, downloaded, error
}

enum AppUpdateErrorContext: String, Codable {
    case check, download, install
}

/// What the web console and the app menu show. Field names match T3's
/// DesktopUpdateState (minus its channels and release notes: the app only
/// follows stable releases, which is all a GitHub release is here).
struct AppUpdateState: Codable, Equatable {
    var enabled: Bool
    var status: AppUpdateStatus
    var currentVersion: String
    /// This Mac ("arm64" | "x64") and the build running ("arm64" | "x64").
    var hostArch: String
    var appArch: String
    var runningUnderArm64Translation: Bool
    var availableVersion: String?
    var downloadedVersion: String?
    var downloadPercent: Double?
    var checkedAt: String?
    var message: String?
    var errorContext: AppUpdateErrorContext?
    var canRetry: Bool
    /// Why `enabled` is false (T3 keeps this beside the state; one field here).
    var disabledReason: String?

    // Optionals encode as null, not as absent keys: the page reads every field.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(status, forKey: .status)
        try c.encode(currentVersion, forKey: .currentVersion)
        try c.encode(hostArch, forKey: .hostArch)
        try c.encode(appArch, forKey: .appArch)
        try c.encode(runningUnderArm64Translation, forKey: .runningUnderArm64Translation)
        try c.encode(availableVersion, forKey: .availableVersion)
        try c.encode(downloadedVersion, forKey: .downloadedVersion)
        try c.encode(downloadPercent, forKey: .downloadPercent)
        try c.encode(checkedAt, forKey: .checkedAt)
        try c.encode(message, forKey: .message)
        try c.encode(errorContext, forKey: .errorContext)
        try c.encode(canRetry, forKey: .canRetry)
        try c.encode(disabledReason, forKey: .disabledReason)
    }

    func json() -> String {
        guard let data = try? JSONEncoder().encode(self), let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}

// MARK: - Reducers (T3 updateMachine.ts, one function each)

enum AppUpdateMachine {
    static func initial(currentVersion: String, hostArch: String, appArch: String, translated: Bool) -> AppUpdateState {
        return AppUpdateState(
            enabled: false, status: .disabled, currentVersion: currentVersion,
            hostArch: hostArch, appArch: appArch, runningUnderArm64Translation: translated,
            availableVersion: nil, downloadedVersion: nil, downloadPercent: nil, checkedAt: nil,
            message: nil, errorContext: nil, canRetry: false, disabledReason: nil)
    }

    /// T3 createBaseUpdateState: idle when updates can run here, disabled (with why) otherwise.
    static func base(_ s: AppUpdateState, disabledReason: String?) -> AppUpdateState {
        var n = initial(currentVersion: s.currentVersion, hostArch: s.hostArch, appArch: s.appArch, translated: s.runningUnderArm64Translation)
        n.enabled = disabledReason == nil
        n.status = disabledReason == nil ? .idle : .disabled
        n.disabledReason = disabledReason
        return n
    }

    static func onCheckStart(_ s: AppUpdateState, checkedAt: String) -> AppUpdateState {
        var n = s
        let hasDownloaded = s.downloadedVersion != nil
        n.status = .checking
        n.checkedAt = checkedAt
        n.message = nil
        n.downloadPercent = hasDownloaded ? 100 : nil
        n.errorContext = nil
        n.canRetry = false
        return n
    }

    static func onCheckFailure(_ s: AppUpdateState, message: String, checkedAt: String) -> AppUpdateState {
        var n = s
        if s.downloadedVersion != nil {
            n.status = .downloaded
            n.message = nil
            n.checkedAt = checkedAt
            n.downloadPercent = 100
            n.errorContext = nil
            n.canRetry = true
            return n
        }
        n.status = .error
        n.message = message
        n.checkedAt = checkedAt
        n.downloadPercent = nil
        n.errorContext = .check
        n.canRetry = true
        return n
    }

    static func onUpdateAvailable(_ s: AppUpdateState, version: String, checkedAt: String) -> AppUpdateState {
        var n = s
        let isDownloaded = s.downloadedVersion == version
        n.status = isDownloaded ? .downloaded : .available
        n.availableVersion = version
        n.downloadedVersion = isDownloaded ? version : nil
        n.downloadPercent = isDownloaded ? 100 : nil
        n.checkedAt = checkedAt
        n.message = nil
        n.errorContext = nil
        n.canRetry = isDownloaded
        return n
    }

    static func onNoUpdate(_ s: AppUpdateState, checkedAt: String) -> AppUpdateState {
        var n = s
        if s.downloadedVersion != nil {
            n.status = .downloaded
            n.availableVersion = s.downloadedVersion
            n.downloadPercent = 100
            n.checkedAt = checkedAt
            n.message = nil
            n.errorContext = nil
            n.canRetry = true
            return n
        }
        n.status = .upToDate
        n.availableVersion = nil
        n.downloadedVersion = nil
        n.downloadPercent = nil
        n.checkedAt = checkedAt
        n.message = nil
        n.errorContext = nil
        n.canRetry = false
        return n
    }

    static func onDownloadStart(_ s: AppUpdateState) -> AppUpdateState {
        var n = s
        n.status = .downloading
        n.downloadPercent = 0
        n.message = nil
        n.errorContext = nil
        n.canRetry = false
        return n
    }

    static func onDownloadFailure(_ s: AppUpdateState, message: String) -> AppUpdateState {
        var n = s
        n.status = s.availableVersion != nil ? .available : .error
        n.message = message
        n.downloadPercent = nil
        n.errorContext = .download
        n.canRetry = s.availableVersion != nil
        return n
    }

    static func onDownloadProgress(_ s: AppUpdateState, percent: Double) -> AppUpdateState {
        var n = s
        n.status = .downloading
        n.downloadPercent = percent
        n.message = nil
        n.errorContext = nil
        n.canRetry = false
        return n
    }

    static func onDownloadComplete(_ s: AppUpdateState, version: String) -> AppUpdateState {
        var n = s
        n.status = .downloaded
        n.availableVersion = version
        n.downloadedVersion = version
        n.downloadPercent = 100
        n.message = nil
        n.errorContext = nil
        n.canRetry = true
        return n
    }

    static func onInstallFailure(_ s: AppUpdateState, message: String) -> AppUpdateState {
        var n = s
        n.status = .downloaded
        n.message = message
        n.errorContext = .install
        n.canRetry = true
        return n
    }

    /// T3 shouldBroadcastDownloadProgress: every 10% step (and 100), not every byte.
    static func shouldBroadcastProgress(_ s: AppUpdateState, nextPercent: Double) -> Bool {
        guard s.status == .downloading, let current = s.downloadPercent else { return true }
        return Int(current / 10) != Int(nextPercent / 10) || nextPercent >= 100
    }

    /// T3 installDownloadedUpdate's admission: a download is there and nothing broke it since.
    static func isInstallable(_ s: AppUpdateState) -> Bool {
        guard s.downloadedVersion != nil else { return false }
        return s.status == .downloaded || (s.status == .error && (s.errorContext == nil || s.errorContext == .install))
    }
}

// MARK: - Versions and the release feed

enum AppUpdateVersion {
    /// Semver order for x.y.z[-pre]: a prerelease sorts below its release.
    /// Returns <0, 0, >0. Anything unparsable sorts lowest.
    static func compare(_ a: String, _ b: String) -> Int {
        func parse(_ v: String) -> (core: [Int], pre: [String])? {
            let trimmed = v.hasPrefix("v") ? String(v.dropFirst()) : v
            let noBuild = trimmed.split(separator: "+", maxSplits: 1).first.map(String.init) ?? trimmed
            let parts = noBuild.split(separator: "-", maxSplits: 1).map(String.init)
            let core = parts[0].split(separator: ".").map { Int($0) }
            guard core.count == 3, core.allSatisfy({ $0 != nil }) else { return nil }
            let pre = parts.count > 1 ? parts[1].split(separator: ".").map(String.init) : []
            return (core.map { $0! }, pre)
        }
        guard let x = parse(a) else { return parse(b) == nil ? 0 : -1 }
        guard let y = parse(b) else { return 1 }
        for i in 0..<3 where x.core[i] != y.core[i] { return x.core[i] < y.core[i] ? -1 : 1 }
        if x.pre.isEmpty || y.pre.isEmpty { return x.pre.isEmpty == y.pre.isEmpty ? 0 : (x.pre.isEmpty ? 1 : -1) }
        for i in 0..<min(x.pre.count, y.pre.count) where x.pre[i] != y.pre[i] {
            switch (Int(x.pre[i]), Int(y.pre[i])) {
            case let (l?, r?): return l < r ? -1 : 1
            case (.some, nil): return -1
            case (nil, .some): return 1
            default: return x.pre[i] < y.pre[i] ? -1 : 1
            }
        }
        return x.pre.count == y.pre.count ? 0 : (x.pre.count < y.pre.count ? -1 : 1)
    }

    static func isNewer(_ candidate: String, than current: String) -> Bool { compare(candidate, current) > 0 }

    /// Whether `v` reads as x.y.z[-pre] at all (a cache entry named after a release).
    static func isVersion(_ v: String) -> Bool { compare(v, "0.0.0") >= 0 && !v.hasPrefix("v") }
}

/// The feed is a GitHub releases page (or a server shaped like one, for tests):
/// `<base>/latest` redirects to `<base>/tag/v<version>`, and each release has
/// `<base>/download/v<version>/Walnut-<arch>.dmg` (.github/workflows/mac-app.yml).
/// No API call, so no rate limit: the same two URLs a browser uses.
enum AppUpdateFeed {
    static let defaultBase = "https://github.com/EvanZhang008/open-walnut/releases"

    static func latestURL(base: String) -> URL? { URL(string: trimmed(base) + "/latest") }

    /// The version a `/latest` redirect points at (`…/tag/v0.6.9` → "0.6.9").
    static func version(fromRedirect location: String) -> String? {
        guard let range = location.range(of: "/tag/", options: .backwards) else { return nil }
        var tag = String(location[range.upperBound...])
        if let cut = tag.firstIndex(where: { $0 == "?" || $0 == "#" || $0 == "/" }) { tag = String(tag[..<cut]) }
        tag = tag.removingPercentEncoding ?? tag
        guard tag.hasPrefix("v") else { return nil }
        let version = String(tag.dropFirst())
        return AppUpdateVersion.compare(version, "0.0.0") >= 0 ? version : nil
    }

    static func dmgName(arch: String) -> String { "Walnut-\(arch).dmg" }

    static func dmgURL(base: String, version: String, arch: String) -> URL? {
        URL(string: "\(trimmed(base))/download/v\(version)/\(dmgName(arch: arch))")
    }

    /// The release page "Read more" opens.
    static func releaseURL(base: String, version: String) -> URL? { URL(string: "\(trimmed(base))/tag/v\(version)") }

    private static func trimmed(_ base: String) -> String {
        var b = base
        while b.hasSuffix("/") { b.removeLast() }
        return b
    }
}

// MARK: - Whether this copy updates at all (T3 getAutoUpdateDisabledReason)

enum AppUpdatePolicy {
    struct Inputs {
        /// A release build names its feed in Info.plist (WalnutUpdateFeed); a test names one in the environment.
        var hasFeed: Bool
        /// Signed with a real identity: an ad-hoc signature changes every build, so
        /// no new build could ever prove it comes from the same developer.
        var hasStableSignature: Bool
        var disabledByEnv: Bool
        /// The app's own path: a DMG mount or an App Translocation copy is read-only.
        var bundlePath: String
    }

    static func disabledReason(_ i: Inputs) -> String? {
        if !i.hasFeed { return "Automatic updates are not available because no update feed is configured." }
        if !i.hasStableSignature { return "Automatic updates are only available in signed release builds." }
        if i.disabledByEnv { return "Automatic updates are disabled by the WALNUT_DISABLE_AUTO_UPDATE setting." }
        if i.bundlePath.hasPrefix("/Volumes/") || i.bundlePath.contains("/AppTranslocation/") {
            return "Move Walnut to the Applications folder to get updates."
        }
        return nil
    }
}

// MARK: - The Walnut a relaunched app carries

enum RuntimeUpgrade {
    /// After an app update, the new app carries a newer Walnut than the one
    /// installed: it installs it before the server starts (offline, a few
    /// seconds), the way T3's update brings its new backend inside the app.
    /// Never a downgrade: a runtime that updated itself past the app (the
    /// nightly channel, `walnut update`) keeps its own.
    ///
    /// A Node archive (`replacesArchive`, the releases before the compiled file)
    /// is replaced by a carried file of its own version too. Under the app that
    /// installed it, it updated itself when its server started, which on an app
    /// launch came before the app's own update was offered, so by the time the
    /// new app runs, the archive is usually at the very version the app carries;
    /// only the app's install moves it to the file. (This app starts it with
    /// updates off and moves it itself: BundledRuntime.servingUpdate.)
    static func shouldInstallCarried(carried: String?, installed: String?, replacesArchive: Bool = false) -> Bool {
        guard let carried = carried else { return false }
        guard let installed = installed else { return true }
        if replacesArchive { return !AppUpdateVersion.isNewer(installed, than: carried) }
        return AppUpdateVersion.isNewer(carried, than: installed)
    }

    /// Get Started and Set Up Now on a Mac where install.sh already left a copy
    /// (`curl … | sh`, an earlier app): it is used as it is, unless the carried
    /// one replaces it by the rule a launch uses, so a setup never starts on what
    /// the next launch would replace.
    static func setupKeepsFound(carried: String?, installed: String?, foundArchive: Bool) -> Bool {
        return !shouldInstallCarried(carried: carried, installed: installed, replacesArchive: foundArchive)
    }
}
