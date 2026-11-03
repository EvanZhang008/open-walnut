import Foundation
import Observation
import UIKit
import UserNotifications

/// The approvals a script is blocked on, and their answers from this phone.
///
/// A push (`data.type == "approval_request"`, src/core/approvals/notify.ts) brings one in:
/// a tap on it opens `ApprovalSheet`; its banner actions answer a tap approval without
/// opening the app (Approve asks for the passcode or Face ID first, the system's
/// `.authenticationRequired`). A biometric approval's Approve is signed in the sheet with
/// this phone's Face ID key (ApprovalSigning). The phone enrolls that key once per server.
@Observable
@MainActor
final class ApprovalCenter {
    static let shared = ApprovalCenter()

    nonisolated static let payloadType = "approval_request"
    nonisolated static let categoryTap = "WALNUT_APPROVAL"
    nonisolated static let categoryBiometric = "WALNUT_APPROVAL_BIOMETRIC"
    nonisolated static let actionApprove = "APPROVAL_APPROVE"
    nonisolated static let actionDeny = "APPROVAL_DENY"

    private(set) var pending: [Approval] = []
    /// The approval the sheet shows; set by a tapped push or when the app comes forward.
    var presented: Approval?
    /// This phone's key as the server knows it (nil before enrolling, or with no Face ID).
    private(set) var myKey: ApprovalKeyInfo?
    private(set) var signReason: String?
    /// Closed by the person: not shown again on its own (a push tap still opens it).
    private var dismissed = Set<String>()
    private var enrolledFor: String?
    private let api: ApprovalsTransport

    init(transport: ApprovalsTransport? = nil) {
        self.api = transport ?? WalnutAPI()
    }

    // MARK: - Push routing (pure)

    nonisolated static func approvalId(fromPush userInfo: [AnyHashable: Any]) -> String? {
        let flat = userInfo["type"] as? String == payloadType ? userInfo["approvalId"] as? String : nil
        let nested = (userInfo["data"] as? [String: Any]).flatMap { $0["type"] as? String == payloadType ? $0["approvalId"] as? String : nil }
        guard let id = flat ?? nested, isValidId(id) else { return nil }
        return id
    }

    /// `apr-` + base64url (server: store.ts createApproval).
    nonisolated static func isValidId(_ raw: String) -> Bool {
        guard raw.hasPrefix("apr-"), raw.count <= 40, raw.count > 4 else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        return raw.dropFirst(4).allSatisfy { allowed.contains($0) }
    }

    nonisolated static func categories() -> Set<UNNotificationCategory> {
        let approve = UNNotificationAction(identifier: actionApprove, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: actionDeny, title: "Deny", options: [.destructive, .authenticationRequired])
        return [
            UNNotificationCategory(identifier: categoryTap, actions: [approve, deny], intentIdentifiers: [], options: []),
            // Face ID happens in the app, so its banner offers only Deny; a tap opens the sheet.
            UNNotificationCategory(identifier: categoryBiometric, actions: [deny], intentIdentifiers: [], options: []),
        ]
    }

    // MARK: - State

    func refresh() async {
        do {
            let r = try await api.approvals()
            pending = r.approvals.filter(\.isPending)
            if let mine = try? ApprovalSigning.publicKey().id {
                myKey = r.keys.first { $0.id == mine }
            }
            if let shown = presented, !pending.contains(where: { $0.id == shown.id }) {
                // Answered elsewhere or expired: the sheet shows its end state from the fetch.
                presented = (try? await api.approval(id: shown.id)) ?? shown
            }
            await enrollIfNeeded(keys: r.keys)
        } catch {
            AppLog.info("approvals", "refresh failed", ["error": String(describing: error)])
        }
    }

    /// The app came forward: show the oldest approval the person has not closed.
    func presentNextIfAny() {
        guard presented == nil else { return }
        if let next = pending.first(where: { !dismissed.contains($0.id) }) { presented = next }
    }

    func open(id: String) async {
        do {
            presented = try await api.approval(id: id)
        } catch {
            AppLog.info("approvals", "open failed", ["approvalId": id, "error": String(describing: error)])
        }
        await refresh()
    }

    func close(_ approval: Approval) {
        dismissed.insert(approval.id)
        if presented?.id == approval.id { presented = nil }
        presentNextIfAny()
    }

    /// Answer one. `signed`: Face ID and this phone's signature (required to Approve a biometric one).
    func answer(_ approval: Approval, decision: String, signed: Bool) async throws -> Approval {
        var keyId: String?
        var signature: String?
        if signed {
            let s = try await ApprovalSigning.sign(approval, decision: decision)
            keyId = s.keyId
            signature = s.signature
        }
        let body = ApprovalAnswerBody(
            decision: decision, keyId: keyId, signature: signature,
            device: .init(name: ApprovalSigning.deviceName, kind: "iphone")
        )
        let done = try await api.answerApproval(id: approval.id, body: body)
        pending.removeAll { $0.id == approval.id }
        if presented?.id == approval.id { presented = done }
        AppLog.info("approvals", "answered", ["approvalId": approval.id, "decision": decision, "signed": signed ? "true" : "false"])
        return done
    }

    var canSign: Bool { myKey?.status == "active" && ApprovalSigning.unavailableReason() == nil }

    /// Once per server: give it this phone's public key (the first device is trusted at
    /// once; a later one waits for an existing device's Face ID or Touch ID approval).
    private func enrollIfNeeded(keys: [ApprovalKeyInfo]) async {
        signReason = ApprovalSigning.unavailableReason()
        guard signReason == nil else { return }
        let server = AppConfig.serverURL?.absoluteString ?? ""
        guard enrolledFor != server else { return }
        do {
            let pub = try ApprovalSigning.publicKey()
            if let known = keys.first(where: { $0.id == pub.id }) {
                myKey = known
                enrolledFor = server
                return
            }
            let r = try await api.enrollApprovalKey(.init(publicKey: pub.base64, name: ApprovalSigning.deviceName, kind: "iphone"))
            myKey = r.key
            enrolledFor = server
            AppLog.info("approvals", "key enrolled", ["keyId": r.key.id, "status": r.key.status])
        } catch {
            // A refusal the person can act on (the first key must come over a direct link, not the
            // companion) is shown on the sheet; a passing network failure is tried at the next refresh.
            if case APIError.server(_, let code, let message, _, _) = error, code == "first_key_from_phone" {
                signReason = message
            }
            AppLog.info("approvals", "enroll failed", ["error": String(describing: error)])
        }
    }

    // MARK: - Banner actions (no UI)

    /// A banner's Approve / Deny on a tap approval. Returns whether it was handled.
    func handleAction(_ actionId: String, approvalId: String) async -> Bool {
        let decision: String
        switch actionId {
        case Self.actionApprove: decision = "approve"
        case Self.actionDeny: decision = "deny"
        default: return false
        }
        do {
            let a = try await api.approval(id: approvalId)
            guard a.isPending else { return true }
            // A biometric approval is never approved from a banner: its Approve needs Face ID in the app.
            if a.isBiometric && decision == "approve" { await open(id: approvalId); return true }
            _ = try await answer(a, decision: decision, signed: false)
        } catch {
            AppLog.info("approvals", "banner answer failed", ["approvalId": approvalId, "error": String(describing: error)])
        }
        return true
    }
}
