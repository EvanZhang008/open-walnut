import Foundation
import Observation
import UIKit
import UserNotifications

/// The approvals a script is blocked on, and their answers from this phone.
///
/// A push (`data.type == "approval_request"`, src/core/approvals/notify.ts) brings one in:
/// a tap on it opens `ApprovalSheet`; its banner actions answer it without opening the app
/// (the system asks for the passcode or Face ID first, `.authenticationRequired`). Every
/// approval is one tap on any device the person is signed in on: this phone needs no key of
/// its own (2026-11-21, the user: a signed-in device approves).
@Observable
@MainActor
final class ApprovalCenter {
    static let shared = ApprovalCenter()

    nonisolated static let payloadType = "approval_request"
    nonisolated static let categoryTap = "WALNUT_APPROVAL"
    nonisolated static let actionApprove = "APPROVAL_APPROVE"
    nonisolated static let actionDeny = "APPROVAL_DENY"

    private(set) var pending: [Approval] = []
    /// The approval the sheet shows; set by a tapped push or when the app comes forward.
    var presented: Approval?
    /// Closed by the person: not shown again on its own (a push tap still opens it).
    private var dismissed = Set<String>()
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
        return [UNNotificationCategory(identifier: categoryTap, actions: [approve, deny], intentIdentifiers: [], options: [])]
    }

    // MARK: - State

    func refresh() async {
        do {
            let r = try await api.approvals()
            pending = r.approvals.filter(\.isPending)
            if let shown = presented, !pending.contains(where: { $0.id == shown.id }) {
                // Answered elsewhere or expired: the sheet shows its end state from the fetch.
                presented = (try? await api.approval(id: shown.id)) ?? shown
            } else if let shown = presented, let fresh = pending.first(where: { $0.id == shown.id }), fresh != shown {
                // Still waiting, with something new to read (Walnut's summary): the open sheet shows it.
                presented = fresh
            }
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

    /// Snoozed on its task's row (ActionNeededView): its sheet is not opened by itself (a push tap still opens it).
    func snoozed(id: String) {
        dismissed.insert(id)
        if presented?.id == id { presented = nil }
    }

    func close(_ approval: Approval) {
        dismissed.insert(approval.id)
        if presented?.id == approval.id { presented = nil }
        presentNextIfAny()
    }

    /// The name this phone answers under (the server prefers its paired-device name).
    static var deviceName: String {
        UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
    }

    /// Answer one with a tap. The body names the digest of the request shown, so one that changed
    /// since is refused (409) rather than approved unseen.
    func answer(_ approval: Approval, decision: String) async throws -> Approval {
        let body = ApprovalAnswerBody(
            decision: decision, digest: approval.digest,
            device: .init(name: Self.deviceName, kind: "iphone")
        )
        let done = try await api.answerApproval(id: approval.id, body: body)
        pending.removeAll { $0.id == approval.id }
        if presented?.id == approval.id { presented = done }
        AppLog.info("approvals", "answered", ["approvalId": approval.id, "decision": decision])
        return done
    }

    // MARK: - Banner actions (no UI)

    /// A banner's Approve / Deny. Returns whether it was handled.
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
            _ = try await answer(a, decision: decision)
        } catch {
            AppLog.info("approvals", "banner answer failed", ["approvalId": approvalId, "error": String(describing: error)])
        }
        return true
    }
}
