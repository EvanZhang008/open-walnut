// ReaderBridge — `Walnut --reader-bridge read|probe <absolute-path>` reads one file
// that macOS keeps behind Full Disk Access and exits, so that permission belongs to
// Walnut itself.
//
// Why the app and not the walnut-reader helper: sessions already run as Walnut
// (desktop/SessionHost.swift), so granting Walnut Full Disk Access is what stops the
// "would like to access data from other apps" popups there. With the reader inside
// the same app, that ONE grant also covers Screen Time and every other protected
// read, and System Settings shows one row, Walnut, instead of Walnut plus a helper
// with a name the user never chose. The helper stays only for installs with no
// Walnut.app (see src/core/protected-reader.ts).
//
// The protocol is src/data/walnut-reader.swift, compiled into this module with
// -D WALNUT_APP so there is exactly one implementation. It re-execs with
// responsibility disclaimed, so the grant is Walnut's whether the server was
// started by this app or from a terminal. Full Disk Access never prompts: a read
// without it fails with "Operation not permitted" and nothing appears on screen.

let readerBridgeFlag = "--reader-bridge"

/// Dispatched FIRST in main.swift, before NSApplication exists, like the session
/// host: a file read must never become a window or a Dock icon. Returns
/// immediately on a normal launch.
func runReaderBridgeIfRequested(_ commandLine: [String] = CommandLine.arguments) {
    guard commandLine.count >= 2, commandLine[1] == readerBridgeFlag else { return }
    // argv-shaped for the shared entry point: program, then the subcommand.
    walnutReaderMain([commandLine[0]] + commandLine.dropFirst(2))
}
