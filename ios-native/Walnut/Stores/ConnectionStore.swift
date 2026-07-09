import Foundation
import Observation

/// Pairing state + server status (LIVE/REPLICA) + reachability.
@Observable
@MainActor
final class ConnectionStore {
    private let api = WalnutAPI()

    var isConfigured: Bool = AppConfig.isConfigured
    var serverURL: String = AppConfig.serverURL?.absoluteString ?? ""
    var deviceName: String = AppConfig.deviceName ?? ""
    var status: ServerStatus?
    /// false after a network-level failure — drives the offline banner.
    var online = true

    init() {
        // Any 401 anywhere bounces the app back to setup.
        NotificationCenter.default.addObserver(
            forName: WalnutAPI.unauthorizedNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.disconnect()
            }
        }
    }

    /// Setup flow: probe /status with the candidate URL + token, persist on success.
    func connect(serverURL rawURL: String, token: String, deviceName name: String?) async throws {
        let probed = try await api.testStatus(serverURL: rawURL, token: token)
        AppConfig.save(serverURL: rawURL, token: token, deviceName: name)
        status = probed
        self.serverURL = AppConfig.serverURL?.absoluteString ?? rawURL
        self.deviceName = name ?? ""
        online = true
        isConfigured = true
    }

    func refreshStatus() async {
        guard isConfigured else { return }
        do {
            status = try await api.status()
            online = true
        } catch let error as APIError {
            if case .network = error { online = false }
        } catch {
            // Non-network errors leave the last known status in place.
        }
    }

    func reportReachability(_ ok: Bool) {
        if online != ok { online = ok }
    }

    /// Wipe the keychain token + prefs and return to setup.
    func disconnect() {
        AppConfig.clear()
        DiskCache.clearAll()
        isConfigured = false
        serverURL = ""
        deviceName = ""
        status = nil
        online = true
    }
}
