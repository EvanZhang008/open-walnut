import Foundation

// MARK: - Approvals endpoints (additive /api/v1, src/web/routes/approvals-v1.ts)
//
// Asking for an approval is a script's action (`walnut approve`) and is absent here: the
// phone only reads them and answers them. A cloud companion forwards every one of these to
// the Mac, where approvals live.

protocol ApprovalsTransport {
    func approvals() async throws -> ApprovalListResponse
    func approval(id: String) async throws -> Approval
    func answerApproval(id: String, body: ApprovalAnswerBody) async throws -> Approval
}

extension WalnutAPI: ApprovalsTransport {
    func approvals() async throws -> ApprovalListResponse {
        try await get("/approvals")
    }

    func approval(id: String) async throws -> Approval {
        let r: ApprovalResponse = try await get("/approvals/\(escape(id))")
        return r.approval
    }

    func answerApproval(id: String, body: ApprovalAnswerBody) async throws -> Approval {
        let r: ApprovalResponse = try await send("POST", "/approvals/\(escape(id))/answer", body: body)
        return r.approval
    }
}
