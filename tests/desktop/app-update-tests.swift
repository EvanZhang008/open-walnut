import Foundation

/// AppUpdateMachine (desktop/AppUpdateMachine.swift): the Mac app's update state,
/// ported from T3 Code's updateMachine.ts. The reducer cases are T3's own tests
/// (apps/desktop/src/updates/updateMachine.test.ts), one block each, so the two
/// machines cannot drift; then the feed, the version order, the reasons a copy
/// does not update, and when a relaunched app installs the Walnut it carries.
@main
struct AppUpdateTests {
    static func base() -> AppUpdateState {
        var s = AppUpdateMachine.initial(currentVersion: "1.0.0", hostArch: "x64", appArch: "x64", translated: false)
        s.enabled = true
        return s
    }

    static func main() {
        let t0 = "2026-03-04T00:00:00.000Z"
        let t1 = "2026-03-04T00:00:01.000Z"

        // The first state is disabled until the updater decides it can run here.
        let first = AppUpdateMachine.initial(currentVersion: "1.0.0", hostArch: "arm64", appArch: "x64", translated: true)
        precondition(first.status == .disabled && !first.enabled && !first.canRetry)
        precondition(AppUpdateMachine.base(first, disabledReason: nil).status == .idle)
        let off = AppUpdateMachine.base(first, disabledReason: "why")
        precondition(off.status == .disabled && !off.enabled && off.disabledReason == "why")
        precondition(off.hostArch == "arm64" && off.appArch == "x64" && off.runningUnderArm64Translation)

        // clears transient errors when a check starts
        do {
            var s = base(); s.status = .error; s.message = "network"; s.errorContext = .check; s.canRetry = true
            let n = AppUpdateMachine.onCheckStart(s, checkedAt: t0)
            precondition(n.status == .checking && n.message == nil && n.errorContext == nil && !n.canRetry)
            precondition(n.checkedAt == t0)
        }
        // records a check failure without exposing an action
        do {
            var s = base(); s.status = .checking
            let n = AppUpdateMachine.onCheckFailure(s, message: "network unavailable", checkedAt: t0)
            precondition(n.status == .error && n.errorContext == .check && n.canRetry)
            precondition(n.message == "network unavailable")
        }
        // preserves an already-downloaded update while checking the feed
        do {
            var s = base(); s.status = .downloaded; s.availableVersion = "1.1.0"; s.downloadedVersion = "1.1.0"; s.downloadPercent = 100
            let checking = AppUpdateMachine.onCheckStart(s, checkedAt: t0)
            let failed = AppUpdateMachine.onCheckFailure(checking, message: "network unavailable", checkedAt: t1)
            precondition(checking.status == .checking && checking.downloadedVersion == "1.1.0" && checking.downloadPercent == 100)
            precondition(failed.status == .downloaded && failed.downloadedVersion == "1.1.0" && failed.message == nil)
            precondition(failed.canRetry)
        }
        // keeps the installer when the feed still offers its version
        do {
            var s = base(); s.status = .downloaded; s.availableVersion = "1.1.0"; s.downloadedVersion = "1.1.0"; s.downloadPercent = 100
            let n = AppUpdateMachine.onUpdateAvailable(s, version: "1.1.0", checkedAt: t0)
            precondition(n.status == .downloaded && n.downloadedVersion == "1.1.0" && n.downloadPercent == 100 && n.canRetry)
        }
        // a newer release than the downloaded one drops the download and offers the new one
        do {
            var s = base(); s.status = .downloaded; s.availableVersion = "1.1.0"; s.downloadedVersion = "1.1.0"; s.downloadPercent = 100
            let n = AppUpdateMachine.onUpdateAvailable(s, version: "1.2.0", checkedAt: t0)
            precondition(n.status == .available && n.availableVersion == "1.2.0" && n.downloadedVersion == nil && n.downloadPercent == nil)
        }
        // preserves available version on download failure for retry
        do {
            var s = base(); s.status = .downloading; s.availableVersion = "1.1.0"; s.downloadPercent = 43
            let n = AppUpdateMachine.onDownloadFailure(s, message: "checksum mismatch")
            precondition(n.status == .available && n.availableVersion == "1.1.0" && n.errorContext == .download && n.canRetry)
            precondition(n.message == "checksum mismatch" && n.downloadPercent == nil)
        }
        // a download failure with no version to retry is an error
        do {
            var s = base(); s.status = .downloading
            let n = AppUpdateMachine.onDownloadFailure(s, message: "gone")
            precondition(n.status == .error && !n.canRetry)
        }
        // transitions to downloaded and then preserves install retry state
        do {
            var s = base(); s.status = .downloading; s.availableVersion = "1.1.0"
            let downloaded = AppUpdateMachine.onDownloadComplete(s, version: "1.1.0")
            let failedInstall = AppUpdateMachine.onInstallFailure(downloaded, message: "backend shutdown timed out")
            precondition(downloaded.status == .downloaded && downloaded.downloadedVersion == "1.1.0")
            precondition(failedInstall.status == .downloaded && failedInstall.errorContext == .install && failedInstall.canRetry)
            precondition(AppUpdateMachine.isInstallable(downloaded) && AppUpdateMachine.isInstallable(failedInstall))
        }
        // preserves a downloaded update when no update is available
        do {
            var s = base(); s.status = .error; s.availableVersion = "1.1.0"; s.downloadedVersion = "1.1.0"
            s.message = "old failure"; s.errorContext = .download; s.canRetry = true
            let n = AppUpdateMachine.onNoUpdate(s, checkedAt: t0)
            precondition(n.status == .downloaded && n.availableVersion == "1.1.0" && n.downloadedVersion == "1.1.0")
            precondition(n.downloadPercent == 100 && n.message == nil && n.errorContext == nil && n.canRetry)
        }
        // clears stale available state when no update is available
        do {
            var s = base(); s.status = .error; s.availableVersion = "1.1.0"
            s.message = "old failure"; s.errorContext = .download; s.canRetry = true
            let n = AppUpdateMachine.onNoUpdate(s, checkedAt: t0)
            precondition(n.status == .upToDate && n.availableVersion == nil && n.downloadedVersion == nil)
            precondition(n.message == nil && n.errorContext == nil && !n.canRetry)
        }
        // tracks available, download start, and progress cleanly
        do {
            var s = base(); s.status = .checking
            let available = AppUpdateMachine.onUpdateAvailable(s, version: "1.1.0", checkedAt: t0)
            let downloading = AppUpdateMachine.onDownloadStart(available)
            let progress = AppUpdateMachine.onDownloadProgress(downloading, percent: 55.5)
            precondition(available.status == .available && !available.canRetry)
            precondition(downloading.status == .downloading && downloading.downloadPercent == 0)
            precondition(progress.downloadPercent == 55.5 && progress.errorContext == nil)
            // Not installable before it is downloaded.
            precondition(!AppUpdateMachine.isInstallable(available) && !AppUpdateMachine.isInstallable(progress))
        }
        // Progress is pushed per 10% step, not per byte.
        do {
            var s = base(); s.status = .downloading; s.downloadPercent = 41
            precondition(!AppUpdateMachine.shouldBroadcastProgress(s, nextPercent: 49.9))
            precondition(AppUpdateMachine.shouldBroadcastProgress(s, nextPercent: 50))
            precondition(AppUpdateMachine.shouldBroadcastProgress(s, nextPercent: 100))
            var idle = base(); idle.status = .available
            precondition(AppUpdateMachine.shouldBroadcastProgress(idle, nextPercent: 0.1))
        }
        // The page reads every field: nil goes out as null, never as a missing key.
        do {
            let json = base().json()
            for key in ["availableVersion", "downloadedVersion", "downloadPercent", "message", "errorContext", "disabledReason"] {
                precondition(json.contains("\"\(key)\":null"), "missing null \(key) in \(json)")
            }
            var s = base(); s.status = .upToDate; s.errorContext = .install
            precondition(s.json().contains("\"status\":\"up-to-date\"") && s.json().contains("\"errorContext\":\"install\""))
        }

        // Version order: semver, a prerelease below its release, a v prefix ignored.
        precondition(AppUpdateVersion.isNewer("0.6.10", than: "0.6.9"))
        precondition(!AppUpdateVersion.isNewer("0.6.9", than: "0.6.9"))
        precondition(AppUpdateVersion.isNewer("0.6.10", than: "0.6.10-nightly.20261011.3"))
        precondition(!AppUpdateVersion.isNewer("0.6.10-nightly.20261011.3", than: "0.6.10"))
        precondition(AppUpdateVersion.isNewer("0.6.11-nightly.1", than: "0.6.10"))
        precondition(AppUpdateVersion.isNewer("1.0.0-rc.10", than: "1.0.0-rc.9"))
        precondition(AppUpdateVersion.isNewer("1.0.0-rc.1", than: "1.0.0-beta.5"))
        precondition(AppUpdateVersion.compare("v1.2.3", "1.2.3") == 0)
        precondition(AppUpdateVersion.isNewer("0.0.1", than: "garbage"))
        precondition(!AppUpdateVersion.isNewer("garbage", than: "0.0.1"))
        // Cache entries named after releases, and nothing else (the swap's script and log stay).
        precondition(AppUpdateVersion.isVersion("0.6.9") && AppUpdateVersion.isVersion("1.0.0-rc.1"))
        precondition(!AppUpdateVersion.isVersion("apply-update.sh") && !AppUpdateVersion.isVersion("apply-update.log"))
        precondition(!AppUpdateVersion.isVersion("v0.6.9") && !AppUpdateVersion.isVersion("0.6"))

        // The feed: a /latest redirect names the version; the DMG sits under download/.
        let gh = AppUpdateFeed.defaultBase
        precondition(AppUpdateFeed.latestURL(base: gh)?.absoluteString == gh + "/latest")
        precondition(AppUpdateFeed.latestURL(base: "http://127.0.0.1:9/releases/")?.absoluteString == "http://127.0.0.1:9/releases/latest")
        precondition(AppUpdateFeed.version(fromRedirect: gh + "/tag/v0.6.9") == "0.6.9")
        precondition(AppUpdateFeed.version(fromRedirect: "/releases/tag/v0.7.0?x=1") == "0.7.0")
        precondition(AppUpdateFeed.version(fromRedirect: gh + "/tag/v1.0.0-rc.1") == "1.0.0-rc.1")
        // Not a release tag: a /latest that lands on the list page (no release yet) or an odd tag.
        precondition(AppUpdateFeed.version(fromRedirect: gh) == nil)
        precondition(AppUpdateFeed.version(fromRedirect: gh + "/tag/nightly") == nil)
        precondition(AppUpdateFeed.version(fromRedirect: gh + "/tag/vnext") == nil)
        precondition(AppUpdateFeed.dmgURL(base: gh, version: "0.6.9", arch: "arm64")?.absoluteString
            == gh + "/download/v0.6.9/Walnut-arm64.dmg")
        precondition(AppUpdateFeed.dmgURL(base: gh, version: "0.6.9", arch: "x64")?.absoluteString
            == gh + "/download/v0.6.9/Walnut-x64.dmg")
        precondition(AppUpdateFeed.releaseURL(base: gh, version: "0.6.9")?.absoluteString == gh + "/tag/v0.6.9")

        // Why a copy does not update, in T3's order: no feed, not a signed release, opted out, read-only place.
        let ok = AppUpdatePolicy.Inputs(hasFeed: true, hasStableSignature: true, disabledByEnv: false, bundlePath: "/Applications/Walnut.app")
        precondition(AppUpdatePolicy.disabledReason(ok) == nil)
        var i = ok; i.hasFeed = false; i.hasStableSignature = false
        precondition(AppUpdatePolicy.disabledReason(i)!.contains("no update feed"))
        i = ok; i.hasStableSignature = false
        precondition(AppUpdatePolicy.disabledReason(i)!.contains("signed release builds"))
        i = ok; i.disabledByEnv = true
        precondition(AppUpdatePolicy.disabledReason(i)!.contains("WALNUT_DISABLE_AUTO_UPDATE"))
        i = ok; i.bundlePath = "/Volumes/Walnut/Walnut.app"
        precondition(AppUpdatePolicy.disabledReason(i)!.contains("Applications folder"))
        i = ok; i.bundlePath = "/private/var/folders/x/T/AppTranslocation/ABC/d/Walnut.app"
        precondition(AppUpdatePolicy.disabledReason(i)!.contains("Applications folder"))
        i = ok; i.bundlePath = "/Users/someone/Applications/Walnut.app"
        precondition(AppUpdatePolicy.disabledReason(i) == nil)

        // A relaunched app installs what it carries only when that is newer.
        precondition(RuntimeUpgrade.shouldInstallCarried(carried: "0.6.9", installed: "0.6.8"))
        precondition(!RuntimeUpgrade.shouldInstallCarried(carried: "0.6.9", installed: "0.6.9"))
        precondition(!RuntimeUpgrade.shouldInstallCarried(carried: "0.6.9", installed: "0.6.10-nightly.20261011.2"))
        precondition(RuntimeUpgrade.shouldInstallCarried(carried: "0.6.10", installed: "0.6.10-nightly.20261011.2"))
        precondition(!RuntimeUpgrade.shouldInstallCarried(carried: nil, installed: "0.6.8"))
        precondition(RuntimeUpgrade.shouldInstallCarried(carried: "0.6.9", installed: nil))
        precondition(RuntimeUpgrade.installedVersion(packageJSON: Data(#"{"name":"open-walnut","version":"0.6.8"}"#.utf8)) == "0.6.8")
        precondition(RuntimeUpgrade.installedVersion(packageJSON: Data("not json".utf8)) == nil)
        precondition(RuntimeUpgrade.installedVersion(packageJSON: nil) == nil)

        print("app-update-tests: ok")
    }
}
