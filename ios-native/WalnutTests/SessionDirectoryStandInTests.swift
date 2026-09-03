import XCTest
@testable import Walnut

/// A directory listing must be titled and rooted by what the SERVER listed, not
/// by what was asked for.
///
/// The defect: tapping `/usr/bin/jq` (an extensionless file, which the linkifier
/// reads as a directory) opened a listing of `/usr/bin` titled "jq", scrolled to
/// "aa", with nothing on screen mentioning jq. The server had already answered
/// honestly — `path:"/usr/bin"`, `selectedFile:"jq"` — and the client kept only
/// `entries`. Naming a listing after something it is not showing is the
/// "confident wrong answer" failure mode: the reader believes they are looking
/// at jq.
@MainActor
final class SessionDirectoryStandInTests: XCTestCase {

    private let root = SessionDirectoryList.effectiveRoot
    private let title = SessionDirectoryList.title

    // MARK: - Root

    func testRootFollowsTheServerWhenItRedirectedToTheParent() {
        XCTAssertEqual(root("/usr/bin/jq", "/usr/bin"), "/usr/bin")
    }

    func testRootIsTheRequestUntilTheServerAnswers() {
        XCTAssertEqual(root("/usr/bin/jq", nil), "/usr/bin/jq")
    }

    /// A server that answered with nothing is not an instruction to root the
    /// browser at "".
    func testEmptyServerPathIsIgnored() {
        XCTAssertEqual(root("/usr/bin", ""), "/usr/bin")
    }

    /// Every child path is built off the root, so the redirect fixes drill-down
    /// too: `/usr/bin/jq` + "aa" used to resolve to `/usr/bin/jq/aa`, which does
    /// not exist.
    func testChildrenHangOffTheServerRootNotTheRequest() {
        let entry = SessionFileEntry(name: "aa", path: nil, type: "file", size: nil, hasChildren: nil)
        XCTAssertEqual(entry.absolutePath(in: root("/usr/bin/jq", "/usr/bin")), "/usr/bin/aa")
    }

    // MARK: - Title

    func testTitleNamesTheDirectoryActuallyListed() {
        XCTAssertEqual(title("/usr/bin/jq", "jq", "/usr/bin"), "bin")
    }

    func testTitleKeepsTheCallersLabelWhenNothingWasRedirected() {
        // The session file browser passes a display name for its cwd; a straight
        // answer must not have it replaced by a recomputed leaf.
        XCTAssertEqual(title("/Users/me/repo", "repo", "/Users/me/repo"), "repo")
        XCTAssertEqual(title("/Users/me/repo", "my project", "/Users/me/repo"), "my project")
    }

    func testTitleKeepsTheCallersLabelWhileTheRequestIsInFlight() {
        XCTAssertEqual(title("/usr/bin/jq", "jq", nil), "jq")
    }

    /// Root itself has no leaf component to name.
    func testTitleFallsBackToThePathWhenThereIsNoLeaf() {
        XCTAssertEqual(title("/x/y", "y", "/"), "/")
    }
}
