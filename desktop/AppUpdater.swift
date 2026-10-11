import Foundation
import Security

// The Mac app's updater: T3 Code's DesktopUpdates.ts (electron-updater on
// Squirrel.Mac) done with the system's own pieces. AppUpdateMachine.swift holds
// the state and decides; this does the I/O and keeps T3's rules:
//
// - a check 15 s after launch, then every 4 minutes; none while downloading;
// - downloads are never automatic: the user starts one (the rail's update item
//   or the app menu), and it ends with a verified copy of the new app;
// - one action at a time (check, download, install), as T3's single reservation;
// - install = stop the server (5 s budget), hand the swap to apply-update.sh and
//   quit; the script waits for this process, swaps the app, and opens it.
//
// What a download proves (Squirrel's own check): the new app satisfies the
// designated requirement of the app that is running, so only a build signed by
// the same developer, for the same bundle id, can replace it.

final class AppUpdater: NSObject, URLSessionDownloadDelegate, URLSessionTaskDelegate {
    enum Action: String { case check, download, install }

    /// Called on the main thread after every state change.
    var onStateChange: ((AppUpdateState) -> Void)?
    /// Install: stop the server (within the given seconds), then quit the app.
    var stopServerAndQuit: ((_ timeout: TimeInterval) -> Void)?

    private(set) var state: AppUpdateState
    private var active: Action?
    private var configured = false
    private var quitting = false
    private let feedBase: String?
    private let startupDelay: TimeInterval
    private let pollInterval: TimeInterval
    private let cacheRoot: URL
    private var pollTimer: Timer?
    private var startupTimer: Timer?
    private var downloadTask: URLSessionDownloadTask?
    private var downloadVersion: String?
    private var downloadDone: ((Bool) -> Void)?
    private lazy var downloadSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    /// HEAD requests that stop at the first redirect (the /latest hop names the version).
    private lazy var probeSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: .main)
    /// HEAD requests that follow redirects (a release asset's lives elsewhere).
    private lazy var assetSession = URLSession(configuration: .ephemeral)
    private let workQueue = DispatchQueue(label: "walnut.app-update", qos: .utility)
    private let log = DesktopLogger.shared

    override init() {
        let env = ProcessInfo.processInfo.environment
        let info = Bundle.main.infoDictionary ?? [:]
        let version = (info["CFBundleShortVersionString"] as? String) ?? "0.0.0"
        #if arch(arm64)
        let appArch = "arm64"
        #else
        let appArch = "x64"
        #endif
        state = AppUpdateMachine.initial(
            currentVersion: version, hostArch: BundledRuntime.machineArch(), appArch: appArch,
            translated: BundledRuntime.sysctlFlag("sysctl.proc_translated"))
        // A release build names its feed in Info.plist; a test names its own server.
        let feed = env["WALNUT_UPDATE_FEED_URL"].flatMap { $0.isEmpty ? nil : $0 } ?? (info["WalnutUpdateFeed"] as? String)
        feedBase = feed.flatMap { $0.isEmpty ? nil : $0 }
        startupDelay = (env["WALNUT_UPDATE_STARTUP_DELAY_MS"].flatMap(Double.init) ?? 15_000) / 1000
        pollInterval = max(5, (env["WALNUT_UPDATE_POLL_MS"].flatMap(Double.init) ?? 240_000) / 1000)
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        cacheRoot = caches.appendingPathComponent("Walnut/Updates", isDirectory: true)
        super.init()
    }

    // MARK: - Configure (T3 configure)

    func configure() {
        let env = ProcessInfo.processInfo.environment
        let reason = AppUpdatePolicy.disabledReason(.init(
            hasFeed: feedBase != nil,
            hasStableSignature: Self.runningAppHasStableSignature(),
            disabledByEnv: ["1", "true", "yes"].contains((env["WALNUT_DISABLE_AUTO_UPDATE"] ?? "").lowercased()),
            bundlePath: Bundle.main.bundlePath))
        setState(AppUpdateMachine.base(state, disabledReason: reason))
        log.log("app_update_configured", fields: [
            "enabled": String(reason == nil), "reason": reason ?? "", "version": state.currentVersion,
            "feed": feedBase ?? "", "hostArch": state.hostArch, "appArch": state.appArch,
        ])
        guard reason == nil else { return }
        configured = true
        removeStaleDownloads()
        startupTimer = Timer.scheduledTimer(withTimeInterval: startupDelay, repeats: false) { [weak self] _ in
            self?.check(reason: "startup")
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.check(reason: "poll")
        }
    }

    // MARK: - Check (T3 checkForUpdates)

    /// Returns false when the check did not run (disabled, busy, quitting).
    @discardableResult
    func check(reason: String, done: ((Bool) -> Void)? = nil) -> Bool {
        guard configured, !quitting else { done?(false); return false }
        if state.status == .downloading {
            log.log("app_update_check_skipped", fields: ["reason": reason, "status": state.status.rawValue])
            done?(false); return false
        }
        guard tryStart(.check) else { done?(false); return false }
        setState(AppUpdateMachine.onCheckStart(state, checkedAt: Self.now()))
        log.log("app_update_checking", fields: ["reason": reason])
        resolveLatest { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .failure(let message):
                self.setState(AppUpdateMachine.onCheckFailure(self.state, message: message, checkedAt: Self.now()))
                self.log.log("app_update_check_failed", fields: ["message": message])
            case .none:
                self.setState(AppUpdateMachine.onNoUpdate(self.state, checkedAt: Self.now()))
            case .some(let version):
                self.setState(AppUpdateMachine.onUpdateAvailable(self.state, version: version, checkedAt: Self.now()))
                self.log.log("app_update_available", fields: ["version": version])
            }
            self.finish(.check)
            done?(true)
        }
        return true
    }

    private enum Latest { case failure(String), none, some(String) }

    /// The newest release, when it is newer than this app and its DMG for this Mac is up.
    private func resolveLatest(_ done: @escaping (Latest) -> Void) {
        guard let base = feedBase, let url = AppUpdateFeed.latestURL(base: base) else { done(.failure("No update feed.")); return }
        var req = URLRequest(url: url, timeoutInterval: 30)
        req.httpMethod = "HEAD"
        probeSession.dataTask(with: req) { [weak self] _, response, error in
            guard let self = self else { return }
            if let error = error { done(.failure("Could not reach the update server: \(error.localizedDescription)")); return }
            guard let http = response as? HTTPURLResponse else { done(.failure("No answer from the update server.")); return }
            let location = (http.value(forHTTPHeaderField: "Location")).map { URL(string: $0, relativeTo: url)?.absoluteString ?? $0 }
            guard (300..<400).contains(http.statusCode), let loc = location else {
                // No release yet answers the list page itself (200) or 404.
                if http.statusCode == 200 || http.statusCode == 404 { done(.none) } else {
                    done(.failure("The update server answered \(http.statusCode)."))
                }
                return
            }
            guard let version = AppUpdateFeed.version(fromRedirect: loc) else { done(.none); return }
            guard AppUpdateVersion.isNewer(version, than: self.state.currentVersion) else { done(.none); return }
            // The release exists before its DMGs are attached (mac-app.yml runs after the
            // archives): until this Mac's is up, there is nothing to offer.
            guard let dmg = AppUpdateFeed.dmgURL(base: base, version: version, arch: self.state.hostArch) else { done(.none); return }
            var head = URLRequest(url: dmg, timeoutInterval: 30)
            head.httpMethod = "HEAD"
            self.assetSession.dataTask(with: head) { _, response, error in
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                DispatchQueue.main.async {
                    if let error = error { done(.failure("Could not reach the update server: \(error.localizedDescription)")) }
                    else if code == 200 { done(.some(version)) }
                    else if code == 404 {
                        self.log.log("app_update_dmg_pending", fields: ["version": version, "url": dmg.absoluteString])
                        done(.none)
                    } else { done(.failure("The update server answered \(code) for \(dmg.lastPathComponent).")) }
                }
            }.resume()
        }.resume()
    }

    // Stop at the /latest redirect so its Location names the version. Downloads follow theirs.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(session === probeSession ? nil : request)
    }

    // MARK: - Download (T3 downloadAvailableUpdate)

    /// `done(true)` once the new app is downloaded and verified.
    func download(done: @escaping (_ accepted: Bool, _ completed: Bool) -> Void) {
        guard configured, state.status == .available, let version = state.availableVersion else { done(false, false); return }
        guard tryStart(.download) else { done(false, false); return }
        setState(AppUpdateMachine.onDownloadStart(state))
        log.log("app_update_downloading", fields: ["version": version])
        let finishWith: (String?) -> Void = { [weak self] failure in
            guard let self = self else { return }
            if let failure = failure {
                self.setState(AppUpdateMachine.onDownloadFailure(self.state, message: failure))
                self.log.log("app_update_download_failed", fields: ["version": version, "message": failure])
            } else {
                self.setState(AppUpdateMachine.onDownloadComplete(self.state, version: version))
                self.log.log("app_update_downloaded", fields: ["version": version])
            }
            self.finish(.download)
            done(true, failure == nil)
        }
        // A copy already downloaded and verified (an earlier launch) is used as it is.
        if verifiedStage(version: version) != nil { finishWith(nil); return }
        guard let base = feedBase, let url = AppUpdateFeed.dmgURL(base: base, version: version, arch: state.hostArch) else {
            finishWith("No download for this Mac."); return
        }
        downloadVersion = version
        downloadDone = { [weak self] ok in
            guard let self = self else { return }
            if !ok { return }
            self.prepare(version: version, finish: finishWith)
        }
        pendingFailure = finishWith
        let task = downloadSession.downloadTask(with: URLRequest(url: url, timeoutInterval: 60))
        downloadTask = task
        task.resume()
    }

    private var pendingFailure: ((String?) -> Void)?

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let percent = min(100, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite) * 100)
        if AppUpdateMachine.shouldBroadcastProgress(state, nextPercent: percent) {
            setState(AppUpdateMachine.onDownloadProgress(state, percent: percent))
        } else {
            state.downloadPercent = percent // kept current for the menu; pushed per 10%
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let version = downloadVersion else { return }
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else {
            failDownload("The download answered \(code)."); return
        }
        // The file is removed when this returns: move it now.
        let dir = cacheRoot.appendingPathComponent(version, isDirectory: true)
        let dmg = dir.appendingPathComponent(AppUpdateFeed.dmgName(arch: state.hostArch))
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: dmg)
            try FileManager.default.moveItem(at: location, to: dmg)
        } catch {
            failDownload("Could not keep the download: \(error.localizedDescription)"); return
        }
        let done = downloadDone
        downloadDone = nil
        self.downloadTask = nil
        done?(true)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard session === downloadSession, let error = error else { return }
        failDownload("The download stopped: \(error.localizedDescription)")
    }

    private func failDownload(_ message: String) {
        downloadDone = nil
        downloadTask = nil
        let fail = pendingFailure
        pendingFailure = nil
        fail?(message)
    }

    /// Mount the DMG, copy its Walnut.app out, check it is ours and the version
    /// we asked for. Off the main thread: a 300 MB copy takes seconds.
    private func prepare(version: String, finish: @escaping (String?) -> Void) {
        pendingFailure = nil
        let dir = cacheRoot.appendingPathComponent(version, isDirectory: true)
        let dmg = dir.appendingPathComponent(AppUpdateFeed.dmgName(arch: state.hostArch))
        let app = dir.appendingPathComponent("Walnut.app", isDirectory: true)
        let mount = dir.appendingPathComponent("mnt", isDirectory: true)
        let requirement = Self.runningAppRequirement()
        let bundleId = Bundle.main.bundleIdentifier
        workQueue.async { [weak self] in
            let failure = Self.unpack(dmg: dmg, mount: mount, into: app)
                ?? Self.verify(app: app, version: version, bundleId: bundleId, requirement: requirement)
            if failure == nil {
                try? FileManager.default.removeItem(at: dmg)
                FileManager.default.createFile(atPath: dir.appendingPathComponent("verified").path, contents: Data(version.utf8))
            } else {
                try? FileManager.default.removeItem(at: app)
            }
            DispatchQueue.main.async { if self != nil { finish(failure) } }
        }
    }

    static func unpack(dmg: URL, mount: URL, into app: URL) -> String? {
        let fm = FileManager.default
        try? fm.removeItem(at: app)
        try? fm.createDirectory(at: mount, withIntermediateDirectories: true)
        let attach = run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        guard attach.ok else { return "Could not open the downloaded disk image: \(attach.output.prefix(300))" }
        defer { _ = run("/usr/bin/hdiutil", ["detach", "-force", mount.path]) }
        let inside = mount.appendingPathComponent("Walnut.app")
        guard fm.fileExists(atPath: inside.path) else { return "The disk image holds no Walnut.app." }
        let copy = run("/usr/bin/ditto", [inside.path, app.path])
        return copy.ok ? nil : "Could not copy the new app: \(copy.output.prefix(300))"
    }

    /// Squirrel.Mac's check: the new bundle is valid and satisfies the running
    /// app's designated requirement (same developer, same bundle id).
    static func verify(app: URL, version: String, bundleId: String?, requirement: SecRequirement?) -> String? {
        guard let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) else {
            return "The new app has no Info.plist."
        }
        if let id = bundleId, (info["CFBundleIdentifier"] as? String) != id { return "The new app is not Walnut (\(info["CFBundleIdentifier"] ?? "no id"))." }
        let got = (info["CFBundleShortVersionString"] as? String) ?? ""
        guard got == version else { return "The download is Walnut \(got), not \(version)." }
        guard let requirement = requirement else { return "This copy of Walnut cannot check signatures." }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code = code else {
            return "The new app could not be read."
        }
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        let status = SecStaticCodeCheckValidity(code, flags, requirement)
        guard status == errSecSuccess else {
            let why = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
            return "The new app is not signed by the same developer as this one (\(why))."
        }
        return nil
    }

    private func verifiedStage(version: String) -> URL? {
        let dir = cacheRoot.appendingPathComponent(version, isDirectory: true)
        let app = dir.appendingPathComponent("Walnut.app", isDirectory: true)
        guard FileManager.default.fileExists(atPath: dir.appendingPathComponent("verified").path),
              FileManager.default.fileExists(atPath: app.path) else { return nil }
        return app
    }

    /// Older downloads (an update since installed, a release since replaced) go,
    /// and so does a copy an interrupted install left beside the app. The last
    /// swap's log stays, and its last line goes into desktop.log.
    private func removeStaleDownloads() {
        let fm = FileManager.default
        let current = state.currentVersion
        let target = Bundle.main.bundleURL
        let log = self.log
        workQueue.async { [cacheRoot] in
            for name in (try? fm.contentsOfDirectory(atPath: cacheRoot.path)) ?? []
            where AppUpdateVersion.isVersion(name) && !AppUpdateVersion.isNewer(name, than: current) {
                try? fm.removeItem(at: cacheRoot.appendingPathComponent(name))
            }
            let parent = target.deletingLastPathComponent()
            for name in (try? fm.contentsOfDirectory(atPath: parent.path)) ?? [] where name.hasPrefix(".Walnut-") && name.hasSuffix(".app") {
                let version = String(name.dropFirst(".Walnut-".count).dropLast(".app".count))
                if AppUpdateVersion.isVersion(version) { try? fm.removeItem(at: parent.appendingPathComponent(name)) }
            }
            let applyLog = cacheRoot.appendingPathComponent("apply-update.log")
            if let text = try? String(contentsOf: applyLog, encoding: .utf8),
               let last = text.split(separator: "\n").last {
                log.log("app_update_last_apply", fields: ["line": String(last)])
            }
        }
    }

    // MARK: - Install (T3 installDownloadedUpdate + quitAndInstall)

    /// `failed` comes back only when the swap could not be prepared; on
    /// success the app quits and the new one opens.
    func install(done: @escaping (_ accepted: Bool, _ failed: Bool) -> Void) {
        guard !quitting, configured, AppUpdateMachine.isInstallable(state), let version = state.downloadedVersion else {
            done(false, false); return
        }
        guard tryStart(.install) else { done(false, false); return }
        guard let stage = verifiedStage(version: version) else {
            // The cache was cleared under it: offer the download again.
            var n = state
            n.downloadedVersion = nil
            n = AppUpdateMachine.onUpdateAvailable(n, version: version, checkedAt: Self.now())
            n.message = "The downloaded update is gone; download it again."
            n.errorContext = .download
            n.canRetry = true
            finish(.install)
            setState(n)
            done(true, true); return
        }
        let target = Bundle.main.bundleURL
        let placed = target.deletingLastPathComponent().appendingPathComponent(".Walnut-\(version).app", isDirectory: true)
        log.log("app_update_installing", fields: ["version": version, "target": target.path])
        workQueue.async { [weak self] in
            // Put next to the app first: if this folder is not ours to write, say so now,
            // while everything still runs, instead of after quitting. A rename when the
            // cache and the app share a volume (the usual case), a copy otherwise.
            let fm = FileManager.default
            try? fm.removeItem(at: placed)
            let moved = (try? fm.moveItem(at: stage, to: placed)) != nil
            let copy = moved ? (ok: true, output: "") : Self.run("/usr/bin/ditto", [stage.path, placed.path])
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard copy.ok else {
                    let message = "Walnut cannot replace itself in \(target.deletingLastPathComponent().path). Move Walnut to the Applications folder, or download it again from the release page."
                    self.setState(AppUpdateMachine.onInstallFailure(self.state, message: message))
                    self.log.log("app_update_install_failed", fields: ["message": message, "detail": String(copy.output.prefix(300))])
                    self.finish(.install)
                    done(true, true)
                    return
                }
                guard self.launchApplyScript(target: target, placed: placed) else {
                    if moved { try? fm.moveItem(at: placed, to: stage) } else { try? fm.removeItem(at: placed) }
                    self.setState(AppUpdateMachine.onInstallFailure(self.state, message: "Could not start the update."))
                    self.finish(.install)
                    done(true, true)
                    return
                }
                self.quitting = true
                self.pollTimer?.invalidate()
                self.startupTimer?.invalidate()
                done(true, false)
                self.stopServerAndQuit?(5)
            }
        }
    }

    private func launchApplyScript(target: URL, placed: URL) -> Bool {
        guard let script = Bundle.main.path(forResource: "apply-update", ofType: "sh") else {
            log.log("app_update_install_failed", fields: ["message": "apply-update.sh missing from the app"])
            return false
        }
        // Run a copy: the original lives inside the bundle that is about to move.
        let copy = cacheRoot.appendingPathComponent("apply-update.sh")
        try? FileManager.default.createDirectory(at: cacheRoot, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: copy)
        guard (try? FileManager.default.copyItem(atPath: script, toPath: copy.path)) != nil else { return false }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/sh")
        proc.arguments = [copy.path, String(ProcessInfo.processInfo.processIdentifier), target.path, placed.path,
                          cacheRoot.appendingPathComponent("apply-update.log").path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch {
            log.log("app_update_install_failed", fields: ["message": error.localizedDescription])
            return false
        }
        log.log("app_update_apply_started", fields: ["pid": String(proc.processIdentifier)])
        return true
    }

    // MARK: - The single action reservation (T3 tryStartUpdateAction)

    var activeAction: Action? { active }

    private func tryStart(_ action: Action) -> Bool {
        if active != nil { return false }
        active = action
        return true
    }

    private func finish(_ action: Action) {
        if active == action { active = nil }
    }

    private func setState(_ next: AppUpdateState) {
        state = next
        onStateChange?(next)
    }

    func releaseURL(version: String) -> URL? {
        feedBase.flatMap { AppUpdateFeed.releaseURL(base: $0, version: version) }
    }

    // MARK: - Helpers

    static func now() -> String { ISO8601DateFormatter().string(from: Date()) }

    static func runningAppRequirement() -> SecRequirement? {
        var me: SecCode?
        guard SecCodeCopySelf([], &me) == errSecSuccess, let me = me else { return nil }
        var staticMe: SecStaticCode?
        guard SecCodeCopyStaticCode(me, [], &staticMe) == errSecSuccess, let staticMe = staticMe else { return nil }
        var req: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(staticMe, [], &req) == errSecSuccess else { return nil }
        return req
    }

    /// An ad-hoc signature's requirement is its own hash: no other build can meet it.
    static func runningAppHasStableSignature() -> Bool {
        guard let req = runningAppRequirement() else { return false }
        var text: CFString?
        guard SecRequirementCopyString(req, [], &text) == errSecSuccess, let s = text as String? else { return false }
        return !s.hasPrefix("cdhash")
    }

    static func run(_ tool: String, _ args: [String]) -> (ok: Bool, output: String) {
        let proc = Process()
        let pipe = Pipe()
        proc.executableURL = URL(fileURLWithPath: tool)
        proc.arguments = args
        proc.standardOutput = pipe
        proc.standardError = pipe
        do { try proc.run() } catch { return (false, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        return (proc.terminationStatus == 0, String(data: data, encoding: .utf8) ?? "")
    }
}
