import AuthenticationServices
import Foundation

/// What iOS shows above the keyboard and in its password sheet before Walnut is even opened: the
/// site, the username and which item, for every login, one-time code and passkey (never a secret).
/// iOS keeps this list itself; Walnut replaces it whole each time the items are opened, so a login
/// saved or removed on the Mac shows here after the next unlock on this iPhone.
enum CredentialIdentities {
    /// An item's id and, for a passkey, which of its passkeys: `<item id>` or `<item id>#pk:<credentialId>`.
    static func record(item: String, passkey: String? = nil) -> String {
        passkey.map { "\(item)#pk:\($0)" } ?? item
    }

    static func parse(record: String) -> (item: String, passkey: String?) {
        guard let r = record.range(of: "#pk:") else { return (record, nil) }
        return (String(record[..<r.lowerBound]), String(record[r.upperBound...]))
    }

    static func identities(for items: [VaultItem]) -> [any ASCredentialIdentity] {
        var out: [any ASCredentialIdentity] = []
        for (rank, item) in items.filter({ !$0.isTrashed }).sorted(by: { ($0.usedAt ?? "") > ($1.usedAt ?? "") }).enumerated() {
            let hosts = Array(NSOrderedSet(array: item.hosts)) as? [String] ?? item.hosts
            if item.type == .login, item.hasPassword, let user = item.username, !user.isEmpty {
                for host in hosts {
                    let id = ASPasswordCredentialIdentity(
                        serviceIdentifier: ASCredentialServiceIdentifier(identifier: host, type: .domain),
                        user: user, recordIdentifier: record(item: item.id))
                    id.rank = max(0, 10_000 - rank)
                    out.append(id)
                }
            }
            if item.hasTotp {
                for host in hosts {
                    let id = ASOneTimeCodeCredentialIdentity(
                        serviceIdentifier: ASCredentialServiceIdentifier(identifier: host, type: .domain),
                        label: item.username?.isEmpty == false ? "\(item.title) (\(item.username!))" : item.title,
                        recordIdentifier: record(item: item.id))
                    id.rank = max(0, 10_000 - rank)
                    out.append(id)
                }
            }
            for pk in item.passkeys ?? [] {
                guard let rp = pk.rpId, let cid = pk.credentialId, let idBytes = PasskeySigner.credentialIdBytes(cid),
                      PasskeySigner.canSign(pk) else { continue }
                let handle = pk.userHandle.flatMap(PasskeySigner.base64URLDecode) ?? Data()
                out.append(ASPasskeyCredentialIdentity(
                    relyingPartyIdentifier: rp, userName: pk.userName ?? item.username ?? item.title,
                    credentialID: idBytes, userHandle: handle, recordIdentifier: record(item: item.id, passkey: cid)))
            }
        }
        return out
    }

    /// Replace iOS's list, when Walnut is turned on as a password app (iOS refuses otherwise).
    static func replace(with items: [VaultItem]) async {
        let store = ASCredentialIdentityStore.shared
        let state = await store.state()
        guard state.isEnabled else { return }
        do {
            try await store.replaceCredentialIdentities(identities(for: items))
        } catch {
            // iOS keeps the last list; the next unlock tries again.
        }
    }

    /// Empty iOS's list (Passwords removed from this iPhone).
    static func removeAll() async {
        let store = ASCredentialIdentityStore.shared
        guard await store.state().isEnabled else { return }
        try? await store.removeAllCredentialIdentities()
    }
}
