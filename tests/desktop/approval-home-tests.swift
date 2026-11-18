import Foundation

// A copy of the Mac app started with another home folder never makes or adds a signing key
// (desktop/ApprovalHome.swift; 2026-11-18 a test's copy put "Let … sign your approvals" on the
// person's screen).
@main
struct ApprovalHomeTests {
    static func main() {
        let account = "/Users/person"
        func refused(_ env: [String: String], _ home: String = account, account acct: String? = account) -> Bool {
            ApprovalHome.refusal(env: env, homeDirectory: home, accountHome: acct) != nil
        }

        // The person's own app: HOME is the account's home, or not set at all.
        precondition(!refused(["HOME": account]))
        precondition(!refused(["HOME": account + "/"]))
        precondition(!refused([:]))

        // A test's copy: a fresh HOME, however Foundation resolves the home folder.
        let testHome = "/Users/person/.local/state/open-walnut/tasks/t1/native-inspect"
        precondition(refused(["HOME": testHome]))
        precondition(refused(["HOME": testHome], testHome))
        precondition(refused([:], testHome))
        precondition(refused(["HOME": account, "CFFIXED_USER_HOME": testHome]))

        // No account home to compare with: refused, never trusted.
        precondition(refused(["HOME": account], account, account: nil))
        precondition(refused(["HOME": account], account, account: ""))

        // The live process: whatever it says, it says it without crashing.
        _ = ApprovalHome.currentRefusal()
        precondition(ApprovalHome.normalized("/") == "/")
        print("approval-home-tests: ok")
    }
}
