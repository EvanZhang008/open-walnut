import XCTest
@testable import Walnut

final class SessionCopyItemTests: XCTestCase {
    func testThreeRowsWithAFolder() {
        let rows = SessionCopyItem.items(sessionId: "s-1", cwd: "/work/repo")
        XCTAssertEqual(rows.map(\.title), ["Copy Folder Path", "Copy Session ID", "Copy Resume Command"])
        XCTAssertEqual(rows.map(\.value), ["/work/repo", "s-1", "cd /work/repo && claude -r s-1"])
    }

    func testNoFolderRowWithoutADirectory() {
        for cwd in [nil, "", "   "] {
            let rows = SessionCopyItem.items(sessionId: "s-2", cwd: cwd)
            XCTAssertEqual(rows.map(\.id), ["session.copyId", "session.copyResume"])
            XCTAssertEqual(rows.last?.value, "claude -r s-2")
        }
    }

    func testAFolderWithSpacesOrQuotesIsOneShellWord() {
        let rows = SessionCopyItem.items(sessionId: "s-3", cwd: "/Users/me/My Repo")
        XCTAssertEqual(rows.last?.value, "cd '/Users/me/My Repo' && claude -r s-3")
        XCTAssertEqual(SessionCopyItem.shellWord("/a/it's"), "'/a/it'\\''s'")
        XCTAssertEqual(SessionCopyItem.shellWord("/a/b-c_d.e"), "/a/b-c_d.e")
    }
}
