import CryptoKit
import XCTest
@testable import Walnut

/// The phone rebuilds an approval's digest itself and signs only that (ApprovalSigning), so
/// it must match the server byte for byte. The digests here are the server's for the same
/// fixtures (tests/core/approvals/approval-signing-parity.test.ts pins them on that side).
final class ApprovalSigningTests: XCTestCase {
    private func approval(mode: String, taskId: String?, detail: String?) -> Approval {
        Approval(
            id: "apr-fixture1", what: "Deploy \u{90E8}\u{7F72} v2 \u{2705}", detail: detail, digest: "",
            mode: mode, downgraded: nil,
            requester: ApprovalRequester(host: "build-box", taskId: taskId, taskTitle: nil, sessionId: nil, cwd: nil, command: nil),
            createdAt: "2026-11-02T23:00:00.000Z", expiresAt: "2026-11-02T23:10:00.000Z",
            status: "pending", answer: nil, enrollsKey: nil
        )
    }

    func testDigestMatchesTheServer() {
        XCTAssertEqual(
            ApprovalSigning.digest(approval(mode: "biometric", taskId: "task-1", detail: "line1\nline2")),
            "9b934a00d16af6e5ebeaf0ed8503c7a2067f07a01182028e267ac4347b6d853a"
        )
        XCTAssertEqual(
            ApprovalSigning.digest(approval(mode: "tap", taskId: nil, detail: nil)),
            "14cc5cc3e64183f6a8fc9c49d2c7404342f90f0442ea8188debb923c2fb644b7"
        )
    }

    func testAnswerMessageAndKeyId() throws {
        XCTAssertEqual(ApprovalSigning.answerMessage(digest: "ab", decision: "approve"), "walnut-approval-answer-v1\nab\napprove")
        let key = P256.Signing.PrivateKey()
        let spki = key.publicKey.derRepresentation
        let id = ApprovalSigning.keyId(spki: spki)
        XCTAssertTrue(id.hasPrefix("ak-"))
        XCTAssertEqual(id.count, 19)
        let sig = try key.signature(for: Data("x".utf8))
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: Data("x".utf8)))
    }

    func testPushRoutingTakesOnlyApprovalIds() {
        XCTAssertEqual(ApprovalCenter.approvalId(fromPush: ["type": "approval_request", "approvalId": "apr-AbC_9-x"]), "apr-AbC_9-x")
        XCTAssertEqual(ApprovalCenter.approvalId(fromPush: ["data": ["type": "approval_request", "approvalId": "apr-1"]]), "apr-1")
        XCTAssertNil(ApprovalCenter.approvalId(fromPush: ["type": "human_inbox_letter", "approvalId": "apr-1"]))
        XCTAssertNil(ApprovalCenter.approvalId(fromPush: ["type": "approval_request", "approvalId": "apr-../x"]))
        XCTAssertNil(ApprovalCenter.approvalId(fromPush: ["type": "approval_request", "approvalId": "lt-1"]))
    }

    func testBannerCategories() {
        let cats = ApprovalCenter.categories()
        let tap = cats.first { $0.identifier == ApprovalCenter.categoryTap }
        let bio = cats.first { $0.identifier == ApprovalCenter.categoryBiometric }
        XCTAssertEqual(tap?.actions.map(\.identifier), [ApprovalCenter.actionApprove, ApprovalCenter.actionDeny])
        // A biometric approval is never approved from a banner.
        XCTAssertEqual(bio?.actions.map(\.identifier), [ApprovalCenter.actionDeny])
    }
}
