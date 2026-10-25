import Cocoa
import Security
import ApplicationServices

@_silgen_name("csops")
private func desktopCsops(_ pid: Int32, _ operation: UInt32, _ buffer: UnsafeMutableRawPointer?, _ size: Int) -> Int32

let desktopUpdateBridgeFlag = "--desktop-update-bridge"

struct InstalledDesktopUpdate: Codable {
    var available: Bool
    var token: String?
    var version: String?
    /// The running app's content windows; the page asks before a restart that would close them.
    var windows: Int? = nil
}

enum DesktopUpdateBridge {
    static func signingInfo(_ code: SecStaticCode) -> [String: Any]? {
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
        return info as? [String: Any]
    }

    static func hash(_ info: [String: Any]) -> String? {
        (info[kSecCodeInfoUnique as String] as? Data)?.map { String(format: "%02x", $0) }.joined()
    }

    static func runningHash(_ pid: pid_t) -> String? {
        var bytes = [UInt8](repeating: 0, count: 20)
        let result = bytes.withUnsafeMutableBytes { desktopCsops(pid, 5, $0.baseAddress, $0.count) }
        return result == 0 ? bytes.map { String(format: "%02x", $0) }.joined() : nil
    }

    static func runningTeam(_ pid: pid_t) -> String? {
        var bytes = [UInt8](repeating: 0, count: 512)
        let result = bytes.withUnsafeMutableBytes { desktopCsops(pid, 14, $0.baseAddress, $0.count) }
        guard result == 0 else { return nil }
        return String(bytes: bytes.dropFirst(8).prefix(while: { $0 != 0 }), encoding: .utf8)
    }

    static func probe(target: URL = Bundle.main.bundleURL) -> (InstalledDesktopUpdate, NSRunningApplication?) {
        let none = InstalledDesktopUpdate(available: false, token: nil, version: nil)
        guard let bundle = Bundle(url: target), let id = bundle.bundleIdentifier else { return (none, nil) }
        var installed: SecStaticCode?
        guard SecStaticCodeCreateWithPath(target as CFURL, [], &installed) == errSecSuccess,
              let installed, SecStaticCodeCheckValidity(installed, [], nil) == errSecSuccess,
              let installedInfo = signingInfo(installed), let installedHash = hash(installedInfo) else { return (none, nil) }
        let apps = NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == id && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && $0.activationPolicy == .regular
        }
        guard apps.count == 1, let app = apps.first else { return (none, nil) }
        guard let runningHash = runningHash(app.processIdentifier), runningHash != installedHash,
              let team = runningTeam(app.processIdentifier), !team.isEmpty,
              team == installedInfo[kSecCodeInfoTeamIdentifier as String] as? String,
              id == installedInfo[kSecCodeInfoIdentifier as String] as? String else { return (none, nil) }
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"\(id)\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCheckValidity(installed, [], requirement) == errSecSuccess else { return (none, nil) }
        let token = "\(app.processIdentifier):\(runningHash):\(installedHash)"
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        // -1: the window list could not be read; the page counts it as a window nobody checked.
        return (InstalledDesktopUpdate(available: true, token: token, version: version, windows: contentWindowCount(app) ?? -1), app)
    }

    /// nil when the window list cannot be read.
    static func contentWindowCount(_ app: NSRunningApplication) -> Int? {
        guard let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        return countContentWindows(windows, pid: app.processIdentifier)
    }

    /// Normal-layer windows bigger than a toolbar that can be seen. A fully transparent one is
    /// AppKit's own (a popover or menu kept for reuse, measured 2026-10-25: two beside the one real
    /// window), never a window the person could have typed into. Minimized windows and ones on
    /// another Space keep their alpha, so they still count.
    static func countContentWindows(_ windows: [[String: Any]], pid: Int32) -> Int {
        windows.filter {
            guard ($0[kCGWindowOwnerPID as String] as? Int32) == pid,
                  ($0[kCGWindowLayer as String] as? Int) == 0,
                  ($0[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let bounds = $0[kCGWindowBounds as String] as? [String: Any],
                  let width = bounds["Width"] as? Double, let height = bounds["Height"] as? Double else { return false }
            return width > 100 && height > 100
        }.count
    }

    /// Exit code 3: other windows are open and nobody checked them.
    static let otherWindowsOpen: Int32 = 3

    /// `force`: the page checked every window, or the user chose to restart anyway.
    static func restart(expected: String, force: Bool = false) -> Int32 {
        let target = Bundle.main.bundleURL
        let (status, app) = probe(target: target)
        guard status.available, status.token == expected, let app, app.processIdentifier > 1 else { return 1 }
        // An older shell cannot check another window's unsent work: refuse unless the page
        // looked at every window or the person chose to restart anyway.
        if !force && (contentWindowCount(app) ?? 2) > 1 { return otherWindowsOpen }
        guard app.terminate() else { return 1 }
        let deadline = Date().addingTimeInterval(30)
        while !app.isTerminated && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
        guard app.isTerminated else { return 1 }
        let opener = Process()
        opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        #if WALNUT_DESKTOP_TEST
        opener.arguments = ["-g", "-j", "-a", target.path]
        #else
        opener.arguments = ["-a", target.path]
        #endif
        do { try opener.run(); opener.waitUntilExit() }
        catch { return 1 }
        guard opener.terminationStatus == 0 else { return 1 }
        let launchDeadline = Date().addingTimeInterval(15)
        while Date() < launchDeadline {
            if NSWorkspace.shared.runningApplications.contains(where: {
                $0.bundleIdentifier == app.bundleIdentifier && $0.activationPolicy == .regular && $0.processIdentifier != app.processIdentifier
                    && runningHash($0.processIdentifier) == expected.split(separator: ":").last.map(String.init)
            }) { return 0 }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return 1
    }
}

func runDesktopUpdateBridgeIfRequested(_ args: [String] = CommandLine.arguments) {
    guard args.count > 1, args[1] == desktopUpdateBridgeFlag else { return }
    if args.count == 3 && args[2] == "status" {
        let status = DesktopUpdateBridge.probe().0
        if let data = try? JSONEncoder().encode(status) { print(String(decoding: data, as: UTF8.self)); exit(0) }
    }
    if args.count >= 4 && args.count <= 5 && args[2] == "restart" && (args.count == 4 || args[4] == "--force") {
        exit(DesktopUpdateBridge.restart(expected: args[3], force: args.count == 5))
    }
    exit(2)
}
