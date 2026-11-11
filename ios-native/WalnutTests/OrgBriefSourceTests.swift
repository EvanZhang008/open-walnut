import XCTest
@testable import Walnut

/// The phone's Brief path source (OrgBriefView.pathSource): the phone has no trusted block offsets,
/// so the whole letter's writers must agree, and a visible literal copy never stands in for an
/// encoded link written by someone else.
final class OrgBriefSourceTests: XCTestCase {
    typealias Source = OrgBriefReply.Letter.Source

    func testEncodedLinkByOneWriterBesideLiteralByAnotherIsUnknown() {
        let a = "[log](/a/my%20log.txt)"
        let text = "\(a) and /a/my log.txt"
        let length = (text as NSString).length
        let aLength = (a as NSString).length
        let spans = [Source(start: 0, end: aLength, by: "task:lead", sessionId: "sid-a"),
                     Source(start: aLength, end: length, by: "human", sessionId: nil)]
        let ref = FilePathRef(path: "/a/my log.txt", raw: "/a/my log.txt")
        XCTAssertEqual(OrgBriefView.pathSource(ref, text: text, sources: spans), .unknown)
    }

    func testOneWriterForTheWholeLetterNamesThatSession() {
        let text = "- see /p/one.ts"
        let spans = [Source(start: 0, end: (text as NSString).length, by: "task:lead", sessionId: "sid-a")]
        XCTAssertEqual(OrgBriefView.pathSource(FilePathRef(path: "/p/one.ts"), text: text, sources: spans), LinkSource(sessionID: "sid-a"))
    }

    func testAnOlderLetterOrSpansThatDoNotCoverItAreUnknown() {
        let text = "- see /p/one.ts"
        let ref = FilePathRef(path: "/p/one.ts")
        XCTAssertEqual(OrgBriefView.pathSource(ref, text: text, sources: nil), .unknown)
        XCTAssertEqual(OrgBriefView.pathSource(ref, text: text, sources: [Source(start: 0, end: 3, by: "human", sessionId: nil)]), .unknown)
    }

    func testAPersonsWholeLetterIsThePrimary() {
        let text = "- see /p/one.ts"
        let spans = [Source(start: 0, end: (text as NSString).length, by: "human", sessionId: nil)]
        XCTAssertEqual(OrgBriefView.pathSource(FilePathRef(path: "/p/one.ts"), text: text, sources: spans), .primary)
    }
}
