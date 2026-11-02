import XCTest
@testable import Walnut

/// A tapped path opens from the host that has it (ClickedPath, GET /v1/files/locate).
final class ClickedPathTests: XCTestCase {
    private let mac = "/Users/someone/.local/state/open-walnut/tasks/t1/video/fix.mp4"

    private func location(_ json: String) throws -> PathLocation {
        try JSONDecoder().decode(PathLocation.self, from: Data(json.utf8))
    }

    func testAMacPathInALinuxSessionOpensFromTheMac() throws {
        let loc = try location(#"{"path":"\#(mac)","found":true,"elsewhere":true,"hostName":"Local","via":"other-host"}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: "/home/someone/work", sessionID: "s1") else {
            return XCTFail("an mp4 opens in the file viewer")
        }
        XCTAssertNil(target.host, "nil host = the primary, the Mac")
        XCTAssertEqual(target.ref.path, mac)
        XCTAssertEqual(target.hostNote, "Opened from your Mac.")
        XCTAssertNil(target.cwd, "the session's cwd is on its own host, not the Mac")
        XCTAssertNil(target.sessionID)
        XCTAssertNil(target.missing)
    }

    func testAPathOnTheSessionHostKeepsItsContext() throws {
        let loc = try location(#"{"path":"/home/someone/work/a.ts","host":"devbox","found":true,"via":"exact","line":9}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: "/home/someone/work/a.ts"), location: loc,
                                                         host: "devbox", cwd: "/home/someone/work", sessionID: "s1") else {
            return XCTFail("text")
        }
        XCTAssertEqual(target.host, "devbox")
        XCTAssertEqual(target.cwd, "/home/someone/work")
        XCTAssertEqual(target.sessionID, "s1")
        XCTAssertEqual(target.ref.line, 9)
        XCTAssertNil(target.hostNote)
    }

    func testAnotherRemoteHostIsNamed() throws {
        let loc = try location(#"{"path":"/home/someone/x.html","host":"spare","hostName":"Spare box","found":true,"elsewhere":true}"#)
        XCTAssertEqual(ClickedPath.route(FilePathRef(path: "/home/someone/x.html"), location: loc,
                                         host: nil, cwd: nil, sessionID: nil),
                       .html(FilePreviewTarget(path: "/home/someone/x.html", host: "spare")))
    }

    func testAPathNoHostHasSaysSoPlainly() throws {
        let loc = try location(#"{"path":"\#(mac)","host":"devbox","found":false,"missing":true,"checked":["Dev box","Local","Spare"]}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: nil, sessionID: nil) else {
            return XCTFail("missing opens the viewer with its line")
        }
        XCTAssertEqual(target.missing, "Couldn't find \(mac) on Dev box, your Mac or Spare.")
        XCTAssertEqual(target.host, "devbox")
    }

    func testAMissingFolderIsNotRoutedToTheFolderSheet() {
        let route = ClickedPath.route(FilePathRef(path: "/Users/someone/gone"), host: nil, cwd: nil, sessionID: nil,
                                      missing: "Couldn't find /Users/someone/gone on your Mac.")
        guard case .text = route else { return XCTFail("a missing path shows its line, never a folder listing") }
    }

    func testAHostThatCannotAnswerOpensOnTheSessionHostAsBefore() throws {
        let loc = try location(#"{"path":"\#(mac)","host":"devbox","found":false}"#)
        guard case .text(let target) = ClickedPath.route(FilePathRef(path: mac), location: loc,
                                                         host: "devbox", cwd: "/w", sessionID: "s1") else {
            return XCTFail("text")
        }
        XCTAssertEqual(target.host, "devbox")
        XCTAssertNil(target.missing)
        XCTAssertNil(target.hostNote)
    }

    func testMissingLineShapes() {
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: ["Local"]), "Couldn't find /x on your Mac.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: ["A", "B"]), "Couldn't find /x on A or B.")
        XCTAssertEqual(ClickedPath.missingLine(path: "/x", checked: []), "Couldn't find /x on any of your machines.")
    }
}
