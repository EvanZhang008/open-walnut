import CryptoKit
import Foundation
import LocalAuthentication
import Security
import UIKit

/// This phone's approval key, and the bytes it signs.
///
/// The key is a P-256 key that signs only after Face ID (or Touch ID): in the Secure
/// Enclave on a real iPhone; where there is none (the simulator) a key kept in the Keychain
/// behind the same biometry check. Walnut holds only the public half
/// (src/core/approvals/keys.ts), so a signature can only come from this phone and a face.
///
/// The digest is rebuilt HERE from the fields the sheet shows, with the server's exact
/// rules (src/core/approvals/digest.ts), and a mismatch refuses to sign: the person signs
/// what they read, and a signature fits that one request only.
enum ApprovalSigning {
    // MARK: - The bytes (twin of src/core/approvals/digest.ts)

    nonisolated static func canonicalText(_ a: Approval) -> String {
        func b64(_ s: String?) -> String { Data((s ?? "").utf8).base64EncodedString() }
        return [
            "walnut-approval-v1",
            "id=\(a.id)",
            "mode=\(a.mode)",
            "created=\(a.createdAt)",
            "expires=\(a.expiresAt)",
            "host=\(b64(a.requester.host))",
            "task=\(a.requester.taskId ?? "")",
            "what=\(b64(a.what))",
            "detail=\(b64(a.detail))",
        ].joined(separator: "\n")
    }

    nonisolated static func digest(_ a: Approval) -> String {
        hex(SHA256.hash(data: Data(canonicalText(a).utf8)))
    }

    nonisolated static func answerMessage(digest: String, decision: String) -> String {
        "walnut-approval-answer-v1\n\(digest)\n\(decision)"
    }

    /// "ak-" + the first 16 hex of sha256(SPKI DER), the server's keyIdOf().
    nonisolated static func keyId(spki: Data) -> String {
        "ak-" + String(hex(SHA256.hash(data: spki)).prefix(16))
    }

    nonisolated private static func hex<D: Sequence>(_ d: D) -> String where D.Element == UInt8 {
        d.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Availability

    enum Unavailable: Error, LocalizedError {
        case noBiometry(String)
        case digestMismatch
        case canceled
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .noBiometry(let why): return why
            case .digestMismatch: return "This request does not match what Walnut recorded, so it was not signed."
            case .canceled: return "Face ID was canceled."
            case .failed(let why): return why
            }
        }
    }

    /// Why this phone cannot sign, or nil when it can.
    static func unavailableReason() -> String? {
        let ctx = LAContext()
        var err: NSError?
        if !ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) {
            if let code = err.map({ LAError.Code(rawValue: $0.code) }), code == .biometryNotEnrolled {
                return "Set up Face ID on this iPhone to sign approvals."
            }
            return "This iPhone has no Face ID or Touch ID available, so it answers approvals with a tap."
        }
        return nil
    }

    // MARK: - The key

    private static let keychainService = "dev.openwalnut.ios.approval-key"
    private static var blobURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Approvals", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("se-key.blob")
    }

    struct PublicKey {
        let spki: Data
        var base64: String { spki.base64EncodedString() }
        var id: String { ApprovalSigning.keyId(spki: spki) }
    }

    /// This phone's public key, made on first use. Making one asks for nothing.
    static func publicKey() throws -> PublicKey {
        if SecureEnclave.isAvailable {
            if let blob = try? Data(contentsOf: blobURL),
               let key = try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob) {
                return PublicKey(spki: key.publicKey.derRepresentation)
            }
            var cfErr: Unmanaged<CFError>?
            guard let access = SecAccessControlCreateWithFlags(
                nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryAny], &cfErr
            ) else { throw Unavailable.failed("Could not make the approval key: \(String(describing: cfErr))") }
            let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
            try key.dataRepresentation.write(to: blobURL, options: [.atomic, .completeFileProtection])
            return PublicKey(spki: key.publicKey.derRepresentation)
        }
        // No Secure Enclave: the public half is kept apart from the guarded private half, so
        // reading it never asks for Face ID.
        if let spki = UserDefaults.standard.data(forKey: "walnut.approvalKey.spki") { return PublicKey(spki: spki) }
        let key = P256.Signing.PrivateKey()
        try storeGuarded(key.rawRepresentation)
        UserDefaults.standard.set(key.publicKey.derRepresentation, forKey: "walnut.approvalKey.spki")
        return PublicKey(spki: key.publicKey.derRepresentation)
    }

    private static func storeGuarded(_ raw: Data) throws {
        var cfErr: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, .biometryAny, &cfErr
        ) else { throw Unavailable.failed("Could not guard the approval key: \(String(describing: cfErr))") }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "p256",
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = raw
        add[kSecAttrAccessControl as String] = access
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw Unavailable.failed("Could not keep the approval key (\(status)).") }
    }

    /// Face ID with the ask as its reason, then the signature over this one decision.
    static func sign(_ approval: Approval, decision: String) async throws -> (keyId: String, signature: String) {
        guard digest(approval) == approval.digest else { throw Unavailable.digestMismatch }
        if let why = unavailableReason() { throw Unavailable.noBiometry(why) }
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
        let verb = decision == "approve" ? "Approve" : "Deny"
        do {
            let ok = try await ctx.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics, localizedReason: "\(verb): \(approval.what)"
            )
            guard ok else { throw Unavailable.canceled }
        } catch let e as LAError where e.code == .userCancel || e.code == .appCancel || e.code == .systemCancel {
            throw Unavailable.canceled
        }
        let message = Data(answerMessage(digest: approval.digest, decision: decision).utf8)
        let pub = try publicKey()
        if SecureEnclave.isAvailable {
            let blob = try Data(contentsOf: blobURL)
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: ctx)
            return (pub.id, try key.signature(for: message).derRepresentation.base64EncodedString())
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "p256",
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: ctx,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let raw = out as? Data else {
            throw Unavailable.failed("The approval key could not be read (\(status)).")
        }
        let key = try P256.Signing.PrivateKey(rawRepresentation: raw)
        return (pub.id, try key.signature(for: message).derRepresentation.base64EncodedString())
    }

    static var deviceName: String {
        UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
    }
}
