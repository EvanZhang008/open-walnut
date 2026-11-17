import Foundation

/// How long a test waits for a NEW web view's first load (or first measure).
///
/// Each new web view starts its own web content process, and the GPU process when none
/// runs; the OS launches them, not the code under test. On CI's busy macOS runner one
/// launch took 13.9 s (2026-11-17, run 44031584501: "WebContent process took 13.909332
/// seconds to launch", "GPU process took 13.927709 seconds"), and a 15 s wait for the
/// preview's sign-in refusal timed out with the page not yet asked for. The waits that use
/// this read the real state (a loader's phase, a measured height), so a pass still returns
/// the moment it is there; only a page that never loads waits this long.
enum WebKitTestBudget {
    static let firstLoad: TimeInterval = 60
}
