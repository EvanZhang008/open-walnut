import Foundation

// Whether this copy of the Mac app may make or add a key that signs the person's approvals
// (ApprovalBridge.swift). Only the app running in the account's own home folder can: a copy started
// with another home (a test that gives the app a fresh HOME so it touches nothing of the person's)
// finds no key there, and before this it made a new Touch ID key and added it to the person's Walnut
// (2026-11-18: "Let "<this Mac>" (Mac app) sign your approvals" on the person's screen, from a
// test's copy; the user: "why ask me? what?"). Such a copy signs nothing, makes no key and asks
// nothing; the person's own app keeps signing. The server adds a Mac key only when this app says
// it runs in the account's home (accountHome in the enroll request, src/web/routes/approvals-v1.ts).
// Foundation only, so scripts/test-desktop.sh tests it anywhere.
enum ApprovalHome {
    static let refusedReason = "This copy of Walnut runs with another home folder (a test or a copy), so it does not sign approvals."

    /// The account's home folder from the user database, never from HOME.
    static func accountHome() -> String? {
        guard let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir else { return nil }
        return String(cString: dir)
    }

    /// A folder path compared by its text: no trailing slash.
    static func normalized(_ path: String) -> String {
        var p = path
        while p.count > 1 && p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// Why this process must not make, add or use a signing key, or nil when it is the account's own app.
    /// `homeDirectory` is where Foundation puts the app's files (NSHomeDirectory()); `env` the process's.
    static func refusal(env: [String: String], homeDirectory: String, accountHome: String?) -> String? {
        guard let account = accountHome.map(normalized), !account.isEmpty else { return refusedReason }
        if let home = env["HOME"], normalized(home) != account { return refusedReason }
        if env["CFFIXED_USER_HOME"] != nil { return refusedReason }
        if normalized(homeDirectory) != account { return refusedReason }
        return nil
    }

    /// This process's answer.
    static func currentRefusal() -> String? {
        refusal(env: ProcessInfo.processInfo.environment, homeDirectory: NSHomeDirectory(), accountHome: accountHome())
    }
}
