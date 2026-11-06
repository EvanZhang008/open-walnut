import AuthenticationServices
import SwiftUI
import UIKit

/// Walnut as an iOS password app (Settings, General, AutoFill & Passwords). iOS starts this for:
///  - the password sheet ("Passwords" above the keyboard, or a login it shows from Walnut): the list;
///  - a login, code or passkey the person picked from the QuickType bar: that one, after Face ID;
///  - the person turning Walnut on: a short screen that fills iOS's suggestion list.
/// The vault key needs Face ID, so nothing is filled without the person: Face ID in this sheet,
/// or in one a minute ago (a code right after its password).
final class CredentialProviderViewController: ASCredentialProviderViewController {
    private let model = VaultModel(server: { VaultServerMirror.load() })
    private var host: UIHostingController<AutoFillRootView>?
    /// The request on screen was answered: a second tap (a double tap on a row, Cancel right
    /// after a fill) must not complete it again.
    private var finished = false

    override func viewDidLoad() {
        super.viewDidLoad()
        model.fillGraceSeconds = 60
        model.onItemsOpened = { items in Task { await CredentialIdentities.replace(with: items) } }
        model.load()
    }

    private func show(_ mode: AutoFillMode) {
        finished = false
        let root = AutoFillRootView(model: model, mode: mode, finish: { [weak self] in self?.finish($0) })
        if let host {
            host.rootView = root
            return
        }
        let h = UIHostingController(rootView: root)
        addChild(h)
        h.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(h.view)
        NSLayoutConstraint.activate([
            h.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            h.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            h.view.topAnchor.constraint(equalTo: view.topAnchor),
            h.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        h.didMove(toParent: self)
        host = h
    }

    private static func hosts(_ ids: [ASCredentialServiceIdentifier]) -> [String] {
        var seen = Set<String>()
        return ids.compactMap { SiteMatch.host(of: $0.identifier) }.filter { seen.insert($0).inserted }
    }

    // MARK: - What iOS asks for

    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        show(.list(hosts: Self.hosts(serviceIdentifiers), kind: .password))
    }

    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters) {
        show(.list(hosts: Self.hosts(serviceIdentifiers), kind: .passkey(AutoFillPasskeyRequest(
            rpId: requestParameters.relyingPartyIdentifier, clientDataHash: requestParameters.clientDataHash,
            allowed: requestParameters.allowedCredentials))))
    }

    override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        show(.list(hosts: Self.hosts(serviceIdentifiers), kind: .oneTimeCode))
    }

    /// The vault key is behind Face ID, so a fill always needs the person: iOS then shows this
    /// extension's screen (prepareInterfaceToProvideCredential).
    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userInteractionRequired.rawValue))
    }

    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
        if let p = credentialRequest as? ASPasskeyCredentialRequest, let identity = p.credentialIdentity as? ASPasskeyCredentialIdentity {
            show(.provide(.passkey(record: identity.recordIdentifier ?? "", request: AutoFillPasskeyRequest(
                rpId: identity.relyingPartyIdentifier, clientDataHash: p.clientDataHash, allowed: []))))
        } else if credentialRequest.type == .oneTimeCode {
            show(.provide(.oneTimeCode(record: credentialRequest.credentialIdentity.recordIdentifier ?? "")))
        } else {
            show(.provide(.password(record: credentialRequest.credentialIdentity.recordIdentifier ?? "")))
        }
    }

    override func prepareInterfaceForExtensionConfiguration() {
        show(.configure)
    }

    override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) {
        show(.passkeyRegistration)
    }

    // MARK: - Answering

    private func finish(_ result: AutoFillResult) {
        guard !finished else { return }
        finished = true
        switch result {
        case .password(let user, let password):
            extensionContext.completeRequest(withSelectedCredential: ASPasswordCredential(user: user, password: password), completionHandler: nil)
        case .oneTimeCode(let code):
            extensionContext.completeOneTimeCodeRequest(using: ASOneTimeCodeCredential(code: code), completionHandler: nil)
        case .passkey(let a, let rpId, let clientDataHash):
            extensionContext.completeAssertionRequest(using: ASPasskeyAssertionCredential(
                userHandle: a.userHandle, relyingParty: rpId, signature: a.signature, clientDataHash: clientDataHash,
                authenticatorData: a.authenticatorData, credentialID: a.credentialID), completionHandler: nil)
        case .configured:
            extensionContext.completeExtensionConfigurationRequest()
        case .canceled:
            extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.userCanceled.rawValue))
        case .notFound:
            extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.credentialIdentityNotFound.rawValue))
        }
    }
}
