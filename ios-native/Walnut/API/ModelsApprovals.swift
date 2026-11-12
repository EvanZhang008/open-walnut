import Foundation

// MARK: - Approvals (additive /api/v1/approvals, src/web/routes/approvals-v1.ts)
//
// A script on one of the user's machines runs `walnut approve "<what>"` and waits until
// the person says yes. The phone shows the ask and answers it: a tap, or for a biometric
// one a signature by this phone's Face ID key (ApprovalSigning.swift).

struct ApprovalRequester: Codable, Equatable, Hashable {
    let host: String
    let taskId: String?
    let taskTitle: String?
    let sessionId: String?
    let cwd: String?
    let command: String?
}

struct ApprovalAnswerRecord: Codable, Equatable, Hashable {
    struct Device: Codable, Equatable, Hashable {
        let id: String?
        let name: String
        let kind: String
    }
    let decision: String
    let at: String
    let mode: String
    let device: Device
}

struct Approval: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let what: String
    let detail: String?
    let digest: String
    let mode: String
    let downgraded: String?
    let requester: ApprovalRequester
    let createdAt: String
    let expiresAt: String
    let status: String
    let answer: ApprovalAnswerRecord?
    let enrollsKey: String?
    /// A single-use approval only this device key may sign (a Git push pins the Mac's key).
    var signingKeyId: String? = nil
    /// Or any one of these keys (the Mac and the iPhone).
    var signingKeyIds: [String]? = nil

    /// The keys that may sign it; empty = any device that signs.
    var boundTo: [String] { signingKeyIds ?? signingKeyId.map { [$0] } ?? [] }

    var isBiometric: Bool { mode == "biometric" }
    var isPending: Bool { status == "pending" }

    /// "Task "Ship v2" on clouddev" / "deploy.sh on build-box" / "A script on mac".
    var requesterLine: String {
        let who: String
        if let title = requester.taskTitle, !title.isEmpty { who = "Task \u{201C}\(title)\u{201D}" }
        else if let command = requester.command, !command.isEmpty { who = command }
        else { who = "A script" }
        return "\(who) on \(requester.host)"
    }

    var expiresDate: Date? { ApprovalDates.parse(expiresAt) }
}

enum ApprovalDates {
    nonisolated static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

struct ApprovalKeyInfo: Codable, Equatable, Hashable {
    let id: String
    let name: String
    let kind: String
    let status: String
}

struct ApprovalListResponse: Codable {
    let approvals: [Approval]
    let keys: [ApprovalKeyInfo]
}

struct ApprovalResponse: Codable {
    let approval: Approval
}

struct ApprovalEnrollResponse: Codable {
    let key: ApprovalKeyInfo
    let enrollment: Approval?
}

struct ApprovalAnswerBody: Encodable {
    struct Device: Encodable {
        let name: String
        let kind: String
    }
    let decision: String
    let keyId: String?
    let signature: String?
    let device: Device
}

struct ApprovalEnrollBody: Encodable {
    let publicKey: String
    let name: String
    let kind: String
}
