import Foundation

/// Connection configuration — server URL + device name in UserDefaults,
/// device token in the Keychain. Read synchronously by the API client.
struct AppConfig {
    private static let urlKey = "walnut.serverUrl"
    private static let nameKey = "walnut.deviceName"
    private static let tokenKey = "walnut.deviceToken"

    static var serverURL: URL? {
        guard let raw = UserDefaults.standard.string(forKey: urlKey) else { return nil }
        return URL(string: raw)
    }

    static var deviceName: String? {
        UserDefaults.standard.string(forKey: nameKey)
    }

    static var token: String? {
        KeychainHelper.get(tokenKey)
    }

    static var isConfigured: Bool {
        serverURL != nil && token != nil
    }

    static func save(serverURL: String, token: String, deviceName: String?) {
        UserDefaults.standard.set(normalize(serverURL), forKey: urlKey)
        if let deviceName, !deviceName.isEmpty {
            UserDefaults.standard.set(deviceName, forKey: nameKey)
        }
        KeychainHelper.set(token, forKey: tokenKey)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: urlKey)
        UserDefaults.standard.removeObject(forKey: nameKey)
        KeychainHelper.delete(tokenKey)
    }

    /// Normalize a user-entered server URL: add https scheme, strip trailing slashes.
    static func normalize(_ input: String) -> String {
        var url = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        if !url.isEmpty, !url.lowercased().hasPrefix("http://"), !url.lowercased().hasPrefix("https://") {
            url = "https://\(url)"
        }
        return url
    }

    /// Parse a `wn://pair?name=<device>&token=<token>[&server=<url>]` pairing
    /// URI. `server` is optional — when present, setup becomes one tap.
    static func parsePairingURI(_ text: String) -> (name: String?, token: String, server: String?)? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.lowercased().hasPrefix("wn://pair?"),
              let components = URLComponents(string: trimmed),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty
        else { return nil }
        let name = components.queryItems?.first(where: { $0.name == "name" })?.value
        let server = components.queryItems?.first(where: { $0.name == "server" })?.value
        return (name, token, server)
    }
}
