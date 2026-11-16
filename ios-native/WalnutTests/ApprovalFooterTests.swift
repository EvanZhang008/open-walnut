import XCTest
@testable import Walnut

/// The approval sheet's bottom bar (2026-11-15, the user, on a sheet that showed a lone Deny and then
/// a small "Denied on a device" box: "就显示了一个 small box of deny"). For every status and mode, and
/// whether this phone signs or not: a request still waiting offers Approve and Deny together (Approve
/// dimmed, under where to approve it, when this phone cannot); one that is answered, withdrawn or out of
/// time says which, with no answer buttons. A status the app does not know yet counts as ended.
final class ApprovalFooterTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_794_700_000)
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func approval(status: String, mode: String, expiresIn: TimeInterval, answer: String? = nil, device: String = #"{"name":"Sam's iPhone","kind":"iphone"}"#, answerMode: String = "tap") throws -> Approval {
        let answerJSON = answer.map { #","answer":{"decision":"\#($0)","at":"2026-11-15T23:08:44.465Z","mode":"\#(answerMode)","device":\#(device)}"# } ?? ""
        let json = """
        {"id":"apr-foot1","what":"Publish a leak gate change","digest":"d","mode":"\(mode)",
         "requester":{"host":"clouddev","taskTitle":"Code repo secret protection"},"createdAt":"\(iso.string(from: now.addingTimeInterval(-60)))",
         "expiresAt":"\(iso.string(from: now.addingTimeInterval(expiresIn)))","status":"\(status)"\(answerJSON)}
        """
        return try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
    }

    func testAWaitingRequestAlwaysOffersApproveAndDenyTogether() throws {
        for mode in ["tap", "biometric"] {
            for canSign in [true, false] {
                let a = try approval(status: "pending", mode: mode, expiresIn: 300)
                let footer = ApprovalSheet.footer(for: a, now: now, canSign: canSign, whereToApprove: "Approve it in the Walnut Mac app with Touch ID.")
                guard case let .answer(approve, blocked) = footer else {
                    return XCTFail("\(mode) canSign=\(canSign): a waiting request showed no answer buttons: \(footer)")
                }
                XCTAssertEqual(approve, mode == "tap" ? .tap : .faceID, "\(mode) canSign=\(canSign)")
                if mode == "biometric" && !canSign {
                    XCTAssertEqual(blocked, "Approve it in the Walnut Mac app with Touch ID.", "a phone that cannot sign says where to approve")
                } else {
                    XCTAssertNil(blocked, "\(mode) canSign=\(canSign): Approve was dimmed on a phone that can approve")
                }
            }
        }
    }

    func testEveryEndedRequestSaysSoWithNoAnswerButtons() throws {
        let cases: [(status: String, expiresIn: TimeInterval, answer: String?, line: String)] = [
            ("pending", -1, nil, "Expired: nobody answered in time"),     // out of time while the sheet is open
            ("pending", 0, nil, "Expired: nobody answered in time"),
            ("approved", 300, "approve", "Approved on Sam's iPhone with a tap"),
            ("approved", 300, nil, "Approved"),
            ("denied", 300, "deny", "Denied on Sam's iPhone"),
            ("denied", 300, nil, "Denied"),
            ("expired", -10, nil, "Expired: nobody answered in time"),
            ("canceled", 300, nil, "Withdrawn: the script stopped asking"),
            ("some-later-status", 300, nil, "No longer waiting for an answer"),
        ]
        for c in cases {
            for mode in ["tap", "biometric"] {
                for canSign in [true, false] {
                    let a = try approval(status: c.status, mode: mode, expiresIn: c.expiresIn, answer: c.answer)
                    let footer = ApprovalSheet.footer(for: a, now: now, canSign: canSign, whereToApprove: "x")
                    guard case let .ended(line, _) = footer else {
                        return XCTFail("\(c.status) \(mode): an ended request still offered answer buttons")
                    }
                    XCTAssertEqual(line, c.line, "\(c.status) \(mode)")
                    XCTAssertFalse(line.contains("a device"), "the end line names no device it does not know")
                }
            }
        }
    }

    /// The request the user approved at 23:08Z on 2026-11-15: asked on the Mac (host "842f578d365e", a
    /// container's hash) and answered in the Mac app, whose device name is that same hash.
    func testTheMacAppAndTheWalnutComputerAreNamedNotHashed() throws {
        let a = try approval(status: "approved", mode: "biometric", expiresIn: 300, answer: "approve",
                             device: #"{"id":"ak-e71d5e306b094f97","name":"842f578d365e","kind":"mac-app"}"#, answerMode: "biometric")
        XCTAssertEqual(ApprovalSheet.endLine(a), "Approved in the Walnut Mac app with Touch ID")
        let json = """
        {"id":"apr-UfRvWZ4ubRma","what":"Publish a leak gate change","digest":"d","mode":"biometric",
         "requester":{"host":"842f578d365e","local":true,"taskTitle":"Code repo secret protection: make it extremely strict"},
         "createdAt":"2026-11-15T23:08:34.773Z","expiresAt":"2026-11-15T23:13:34.773Z","status":"pending"}
        """
        let asked = try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
        XCTAssertEqual(asked.requesterLine, "Task \u{201C}Code repo secret protection: make it extremely strict\u{201D} on the computer Walnut runs on")
    }
}
