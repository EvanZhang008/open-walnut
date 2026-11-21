import XCTest
@testable import Walnut

/// The approval sheet's bottom bar (2026-11-15, the user, on a sheet that showed a lone Deny and then
/// a small "Denied on a device" box: "就显示了一个 small box of deny"; 2026-11-21, on a greyed Approve:
/// "这个 button 在手机上一直不工作"). For every status and mode: a request still waiting offers Approve
/// and Deny together, both live, whatever mode an older record names; one that is answered, withdrawn
/// or out of time says which, with no answer buttons. A status the app does not know yet counts as ended.
final class ApprovalFooterTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_794_700_000)
    private let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func approval(status: String, mode: String, expiresIn: TimeInterval, answer: String? = nil, device: String = #"{"name":"Sam's iPhone","kind":"iphone"}"#, answerMode: String = "tap", extra: String = "") throws -> Approval {
        let answerJSON = answer.map { #","answer":{"decision":"\#($0)","at":"2026-11-15T23:08:44.465Z","mode":"\#(answerMode)","device":\#(device)}"# } ?? ""
        let json = """
        {"id":"apr-foot1","what":"Publish a leak gate change","digest":"d","mode":"\(mode)",
         "requester":{"host":"clouddev","taskTitle":"Code repo secret protection"},"createdAt":"\(iso.string(from: now.addingTimeInterval(-60)))",
         "expiresAt":"\(iso.string(from: now.addingTimeInterval(expiresIn)))","status":"\(status)"\(answerJSON)\(extra)}
        """
        return try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
    }

    func testAWaitingRequestAlwaysOffersLiveApproveAndDeny() throws {
        // An older server's record may still name a device key or a Face ID mode: the phone answers it with a tap.
        let older = [
            "",
            #","signingKeyId":"ak-dcb7a1b2c3d4e5f6""#,
            #","signingKeyIds":["ak-dcb7a1b2c3d4e5f6","ak-e71d5e306b094f97"],"singleUse":true"#,
            #","enrollsKey":"ak-f9ca0011223344aa","downgraded":"No device signs approvals yet""#,
        ]
        for mode in ["tap", "biometric"] {
            for extra in older {
                let a = try approval(status: "pending", mode: mode, expiresIn: 300, extra: extra)
                XCTAssertEqual(ApprovalSheet.footer(for: a, now: now), .answer, "\(mode) \(extra): a waiting request must offer a live Approve")
            }
        }
    }

    func testEveryEndedRequestSaysSoWithNoAnswerButtons() throws {
        let cases: [(status: String, expiresIn: TimeInterval, answer: String?, line: String)] = [
            ("pending", -1, nil, "Expired: nobody answered in time"),     // out of time while the sheet is open
            ("pending", 0, nil, "Expired: nobody answered in time"),
            ("approved", 300, "approve", "Approved on Sam's iPhone"),
            ("approved", 300, nil, "Approved"),
            ("denied", 300, "deny", "Denied on Sam's iPhone"),
            ("denied", 300, nil, "Denied"),
            ("expired", -10, nil, "Expired: nobody answered in time"),
            ("canceled", 300, nil, "Withdrawn: the script stopped asking"),
            ("some-later-status", 300, nil, "No longer waiting for an answer"),
        ]
        for c in cases {
            for mode in ["tap", "biometric"] {
                let a = try approval(status: c.status, mode: mode, expiresIn: c.expiresIn, answer: c.answer)
                guard case let .ended(line, _) = ApprovalSheet.footer(for: a, now: now) else {
                    return XCTFail("\(c.status) \(mode): an ended request still offered answer buttons")
                }
                XCTAssertEqual(line, c.line, "\(c.status) \(mode)")
                XCTAssertFalse(line.contains("a device"), "the end line names no device it does not know")
            }
        }
    }

    /// The request the user approved at 23:08Z on 2026-11-15: asked on the Mac (host "842f578d365e", a
    /// container's hash) and answered in the Mac app, whose device name is that same hash.
    func testTheMacAppAndTheWalnutComputerAreNamedNotHashed() throws {
        let a = try approval(status: "approved", mode: "biometric", expiresIn: 300, answer: "approve",
                             device: #"{"id":"ak-e71d5e306b094f97","name":"842f578d365e","kind":"mac-app"}"#, answerMode: "biometric")
        XCTAssertEqual(ApprovalSheet.endLine(a), "Approved in the Walnut Mac app")
        let json = """
        {"id":"apr-UfRvWZ4ubRma","what":"Publish a leak gate change","digest":"d","mode":"biometric",
         "requester":{"host":"842f578d365e","local":true,"taskTitle":"Code repo secret protection: make it extremely strict"},
         "createdAt":"2026-11-15T23:08:34.773Z","expiresAt":"2026-11-15T23:13:34.773Z","status":"pending"}
        """
        let asked = try JSONDecoder().decode(Approval.self, from: Data(json.utf8))
        XCTAssertEqual(asked.requesterLine, "Task \u{201C}Code repo secret protection: make it extremely strict\u{201D} on the computer Walnut runs on")
    }

    /// The answer carries the digest of the request the sheet showed, and no key or signature.
    func testTheAnswerBodyIsATapWithTheDigest() throws {
        let body = ApprovalAnswerBody(decision: "approve", digest: "abc123", device: .init(name: "Sam's iPhone", kind: "iphone"))
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(body)) as? [String: Any])
        XCTAssertEqual(obj["decision"] as? String, "approve")
        XCTAssertEqual(obj["digest"] as? String, "abc123")
        XCTAssertNil(obj["keyId"])
        XCTAssertNil(obj["signature"])
    }

    /// The list from a server that still sends `keys` (always empty) decodes, and so does one without it.
    func testTheListDecodesWithOrWithoutKeys() throws {
        for keys in [#","keys":[]"#, #","keys":[{"id":"ak-1","name":"Mac","kind":"mac-app","status":"active"}]"#, ""] {
            let r = try JSONDecoder().decode(ApprovalListResponse.self, from: Data(#"{"approvals":[]\#(keys)}"#.utf8))
            XCTAssertEqual(r.approvals.count, 0)
        }
    }
}
