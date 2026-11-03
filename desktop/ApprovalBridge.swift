import CryptoKit
import Foundation
import LocalAuthentication
import WebKit

// The Mac app's Touch ID signer for Walnut approvals (src/core/approvals/). The page asks
// through webkit.messageHandlers.walnutApproval.postMessage({op}) and gets a promise
// (web/src/components/approvals/touch-id-bridge.ts):
//   {op:"status"}                       -> {available, reason?, keyId?, publicKey?, name}
//   {op:"sign", approval, decision}     -> Touch ID, then {keyId, signature} or {error}
// The key is made in this Mac's Secure Enclave and signs only after Touch ID (no password
// fallback), so no process on this Mac, an agent's included, can sign without a finger.
// The digest is rebuilt here from the fields the page sends, with the server's own rules
// (src/core/approvals/digest.ts); a mismatch is refused, so the person signs what they read.
final class ApprovalBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let shared = ApprovalBridge()
    static let handlerName = "walnutApproval"

    private var blobURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Walnut", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("approval-key.blob")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only the console page itself: never a frame inside it (a session's web service, a plugin
        // page), which could otherwise raise Touch ID and take the signature.
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, let page = message.webView?.url,
              origin.protocol == page.scheme, origin.host == page.host, origin.port == (page.port ?? 0) else {
            replyHandler(nil, "approvals are signed only from the Walnut console page")
            return
        }
        let body = message.body as? [String: Any] ?? [:]
        switch body["op"] as? String ?? "" {
        case "status":
            replyHandler(status(), nil)
        case "sign":
            let fields = body["approval"] as? [String: Any] ?? [:]
            let decision = body["decision"] as? String ?? ""
            sign(fields: fields, decision: decision) { replyHandler($0, nil) }
        default:
            replyHandler(nil, "unknown op")
        }
    }

    // MARK: - The bytes (twin of src/core/approvals/digest.ts)

    static func canonicalText(_ f: [String: Any]) -> String {
        func s(_ k: String) -> String { f[k] as? String ?? "" }
        func b64(_ v: String) -> String { Data(v.utf8).base64EncodedString() }
        return [
            "walnut-approval-v1",
            "id=\(s("id"))",
            "mode=\(s("mode"))",
            "created=\(s("createdAt"))",
            "expires=\(s("expiresAt"))",
            "host=\(b64(s("host")))",
            "task=\(s("taskId"))",
            "what=\(b64(s("what")))",
            "detail=\(b64(s("detail")))",
        ].joined(separator: "\n")
    }

    static func hex<D: Sequence>(_ d: D) -> String where D.Element == UInt8 { d.map { String(format: "%02x", $0) }.joined() }
    static func digest(_ f: [String: Any]) -> String { hex(SHA256.hash(data: Data(canonicalText(f).utf8))) }
    static func keyId(_ spki: Data) -> String { "ak-" + String(hex(SHA256.hash(data: spki)).prefix(16)) }

    // MARK: - Key and availability

    private func unavailableReason() -> String? {
        guard SecureEnclave.isAvailable else { return "This Mac has no Secure Enclave, so it answers approvals with a click." }
        var err: NSError?
        if !LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
            if let e = err, LAError.Code(rawValue: e.code) == .biometryNotEnrolled {
                return "Add a fingerprint in System Settings, Touch ID, to sign approvals on this Mac."
            }
            return "This Mac has no Touch ID, so it answers approvals with a click."
        }
        return nil
    }

    private func loadOrMakeKey() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let blob = try? Data(contentsOf: blobURL), let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) {
            return key
        }
        var cfErr: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
                                                           [.privateKeyUsage, .biometryAny], &cfErr) else {
            throw NSError(domain: "walnut.approval", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not make the approval key."])
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try key.dataRepresentation.write(to: blobURL, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: blobURL.path)
        return key
    }

    private var deviceName: String { Host.current().localizedName ?? "Mac" }

    private func status() -> [String: Any] {
        if let why = unavailableReason() { return ["available": false, "reason": why, "name": deviceName] }
        do {
            let key = try loadOrMakeKey()
            let spki = key.publicKey.derRepresentation
            return ["available": true, "keyId": Self.keyId(spki), "publicKey": spki.base64EncodedString(), "name": deviceName]
        } catch {
            return ["available": false, "reason": error.localizedDescription, "name": deviceName]
        }
    }

    private func sign(fields: [String: Any], decision: String, done: @escaping ([String: Any]) -> Void) {
        guard decision == "approve" || decision == "deny" else { done(["error": "decision is approve or deny"]); return }
        guard let digest = fields["digest"] as? String, Self.digest(fields) == digest else {
            done(["error": "This request does not match what Walnut recorded, so it was not signed."]); return
        }
        if let why = unavailableReason() { done(["error": why]); return }
        let ctx = LAContext()
        let what = fields["what"] as? String ?? "a step"
        let verb = decision == "approve" ? "approve" : "deny"
        ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "\(verb) \u{201C}\(what)\u{201D}") { ok, err in
            DispatchQueue.main.async {
                guard ok else { done(["error": err?.localizedDescription ?? "Touch ID was canceled."]); return }
                do {
                    let blob = try Data(contentsOf: self.blobURL)
                    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
                    let message = Data("walnut-approval-answer-v1\n\(digest)\n\(decision)".utf8)
                    let signature = try key.signature(for: message).derRepresentation.base64EncodedString()
                    done(["keyId": Self.keyId(key.publicKey.derRepresentation), "signature": signature])
                } catch {
                    done(["error": "Not signed: \(error.localizedDescription)"])
                }
            }
        }
    }
}
