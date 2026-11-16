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
    /// Asked on the computer the Walnut server runs on (its host name there is often a container's hash).
    var local: Bool? = nil
}

/// What Walnut read when it was asked (src/core/approvals/asker-context.ts); only the parts the
/// sheet shows. An older server sends none, and an older app ignores it.
struct ApprovalContext: Codable, Equatable, Hashable {
    var why: String? = nil
    /// "asker": its own `--why`; "session": the session's last words (never shown as a reason).
    var whyFrom: String? = nil
    /// What the step does and why, written by Walnut when the asker gave no why (summary.ts).
    var summary: String? = nil
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
    var context: ApprovalContext? = nil
    /// "summary": the detail is the request in words, read whole; else it is technical (folded).
    var detailRole: String? = nil
    /// A single-use ask's detail is a signed envelope: always technical.
    var singleUse: Bool? = nil

    /// The words on top of the sheet, as the web dialog leads with them (approval-context.tsx
    /// summaryOf): the asker's own line and why, else the summary Walnut wrote.
    var lead: (text: String, byWalnut: Bool, why: String?) {
        if let s = context?.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty, context?.whyFrom != "asker" {
            return (s, true, nil)
        }
        let why = context?.whyFrom == "asker" ? context?.why?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        return (what, false, (why?.isEmpty ?? true) ? nil : why)
    }

    /// Walnut writes a summary for it, not yet arrived: the sheet reads it again shortly.
    var awaitsSummary: Bool { isPending && context?.whyFrom != "asker" && (context?.summary ?? "").isEmpty }

    /// The keys that may sign it; empty = any device that signs.
    var boundTo: [String] { signingKeyIds ?? signingKeyId.map { [$0] } ?? [] }

    /// The request in words, shown whole under the lead (Walnut's own asks), else nil.
    /// Twin of web/src/components/approvals/approval-context.tsx wordsOf.
    var words: String? {
        guard detailRole == "summary", singleUse != true, let d = detail?.trimmingCharacters(in: .whitespacesAndNewlines), !d.isEmpty else { return nil }
        return detail
    }

    /// The technical detail folded under Details: a signed envelope's context laid out, or the
    /// detail as it is (detailText). Nil when there is none or the detail is the words.
    var technicalDetail: (text: String, signed: Bool)? {
        guard words == nil, let d = detail, !d.isEmpty else { return nil }
        if singleUse == true, let env = Self.envelope(d), let ctx = env["context"] as? String {
            return (Self.prettyJSON(ctx), true)
        }
        return (Self.prettyJSON(d), false)
    }

    /// Where a signed Git operation acts: "~/…/meta-fresh → mainline", from its signed context.
    /// Twin of approval-context.tsx gitOperation + whereLine.
    var repoLine: String? {
        guard singleUse == true, let d = detail, let env = Self.envelope(d), let ctx = env["context"] as? String,
              let data = ctx.data(using: .utf8),
              let c = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              c["version"] as? String == "walnut-git-operation-v1",
              let repo = c["repository"] as? String, !repo.isEmpty else { return nil }
        let branch = (c["remoteRef"] as? String)?.replacingOccurrences(of: "refs/heads/", with: "")
        return Self.shortPath(repo) + (branch.map { " \u{2192} \($0)" } ?? "")
    }

    private static func envelope(_ d: String) -> [String: Any]? {
        guard let data = d.data(using: .utf8),
              let env = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              env["version"] as? String == "walnut-single-use-v1" else { return nil }
        return env
    }

    /// A one-line JSON object laid out one field a line; any other text as it is.
    static func prettyJSON(_ text: String) -> String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("{") || t.hasPrefix("["), let data = t.data(using: .utf8),
              let v = try? JSONSerialization.jsonObject(with: data),
              let out = try? JSONSerialization.data(withJSONObject: v, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let s = String(data: out, encoding: .utf8) else { return text }
        return s
    }

    /// A path with its home folder said as "~" (shortPath on the web).
    static func shortPath(_ p: String) -> String {
        p.replacingOccurrences(of: #"^(?:/local)?/home/(?!linuxbrew(?:/|$))[^/]+(?=/|$)|^/Users/(?!(?:Shared|Guest)(?:/|$))[^/]+(?=/|$)|^/root(?=/|$)"#, with: "~", options: .regularExpression)
    }

    var isBiometric: Bool { mode == "biometric" }
    var isPending: Bool { status == "pending" }

    /// "Task "Ship v2" on clouddev" / "deploy.sh on build-box" / "A script on mac".
    var requesterLine: String {
        let who: String
        if let title = requester.taskTitle, !title.isEmpty { who = "Task \u{201C}\(title)\u{201D}" }
        else if let command = requester.command, !command.isEmpty { who = command }
        else { who = "A script" }
        // A container's hash (842f578d365e) tells the person nothing: say which computer it is.
        return "\(who) on \(requester.local == true ? "the computer Walnut runs on" : requester.host)"
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
