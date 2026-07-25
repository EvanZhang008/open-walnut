import Foundation
import Observation
import UIKit

/// Pairing state + server status (LIVE/REPLICA) + attributed reachability.
@Observable
@MainActor
final class ConnectionStore {
    private let api = WalnutAPI()
    private var consecutiveFailures = 0
    private var probeTask: Task<Void, Never>?
    private var isActive = true

    var isConfigured: Bool = AppConfig.isConfigured
    var serverURL: String = AppConfig.serverURL?.absoluteString ?? ""
    var deviceName: String = AppConfig.deviceName ?? ""
    var status: ServerStatus?
    /// false only after two consecutive REST transport failures.
    var online = true

    init() {
        LifecycleHub.shared.register(self)
        // Any 401 anywhere bounces the app back to setup.
        NotificationCenter.default.addObserver(
            forName: WalnutAPI.unauthorizedNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.disconnect() }
        }
    }

    /// Setup flow: probe /status with the candidate URL + token, persist on success.
    func connect(serverURL rawURL: String, token: String, deviceName name: String?) async throws {
        let started = Date()
        let probed = try await api.testStatus(serverURL: rawURL, token: token)
        AppConfig.save(serverURL: rawURL, token: token, deviceName: name)
        status = probed
        self.serverURL = AppConfig.serverURL?.absoluteString ?? rawURL
        self.deviceName = name ?? ""
        isConfigured = true
        reportReachability(true, source: "setup-rest", endpoint: "/api/v1/status", latencyMs: Self.latency(since: started))
    }

    func refreshStatus() async {
        guard isConfigured else { return }
        let started = Date()
        do {
            status = try await api.status()
            reportReachability(true, source: "status-rest", endpoint: "/api/v1/status", latencyMs: Self.latency(since: started))
        } catch let error as APIError {
            guard !error.isCancelled else { return }
            if case .network = error {
                reportReachability(false, source: "status-rest", endpoint: "/api/v1/status", error: error,
                                   latencyMs: Self.latency(since: started))
            }
        } catch {
            // Non-network errors leave the last known status in place.
        }
    }

    /// REST successes reset the gate; REST failures flip offline only after two
    /// consecutive samples. SSE churn is logged but never counted.
    func reportReachability(
        _ ok: Bool,
        source: String,
        endpoint: String? = nil,
        error: Error? = nil,
        latencyMs: Int? = nil
    ) {
        let oldState = online
        let isSSE = source.lowercased().contains("sse")

        if ok {
            // SSE health must not mask a REST-only outage: a healthy stream
            // resetting the counter would keep the gate from ever tripping.
            if !isSSE { consecutiveFailures = 0 }
            online = true
        } else if !isSSE {
            consecutiveFailures += 1
            if consecutiveFailures >= 2 { online = false }
        }

        let transitioned = oldState != online
        if transitioned || !ok {
            logConnectivity(
                oldState: oldState,
                newState: online,
                source: source,
                endpoint: endpoint,
                error: error,
                latencyMs: latencyMs,
                suppressed: !transitioned && !ok
            )
        }

        if oldState && !online {
            startRecoveryProbe()
        } else if !oldState && online {
            probeTask?.cancel()
            probeTask = nil
            AppLog.shared.flushAfterConnectivityRecovery()
        }
    }

    /// Wipe the keychain token + prefs and return to setup.
    func disconnect() {
        probeTask?.cancel()
        probeTask = nil
        AppConfig.clear()
        DiskCache.clearAll()
        isConfigured = false
        serverURL = ""
        deviceName = ""
        status = nil
        consecutiveFailures = 0
        online = true
    }

    private func startRecoveryProbe() {
        guard probeTask == nil, isConfigured else { return }
        probeTask = Task { [weak self] in
            var delay: Double = 10
            while !Task.isCancelled {
                guard let self else { return }
                guard self.isActive, UIApplication.shared.applicationState == .active else {
                    try? await Task.sleep(for: .seconds(1))
                    continue
                }
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, self.isActive, !self.online else { return }
                let started = Date()
                do {
                    self.status = try await self.api.status()
                    self.reportReachability(
                        true,
                        source: "recovery-rest",
                        endpoint: "/api/v1/status",
                        latencyMs: Self.latency(since: started)
                    )
                    return
                } catch let error as APIError {
                    guard !error.isCancelled else { continue }
                    self.logConnectivity(
                        oldState: self.online,
                        newState: self.online,
                        source: "recovery-rest",
                        endpoint: "/api/v1/status",
                        error: error,
                        latencyMs: Self.latency(since: started),
                        suppressed: true
                    )
                } catch {
                    self.logConnectivity(
                        oldState: self.online,
                        newState: self.online,
                        source: "recovery-rest",
                        endpoint: "/api/v1/status",
                        error: error,
                        latencyMs: Self.latency(since: started),
                        suppressed: true
                    )
                }
                delay = min(delay * 1.5, 30)
            }
        }
    }

    private func logConnectivity(
        oldState: Bool,
        newState: Bool,
        source: String,
        endpoint: String?,
        error: Error?,
        latencyMs: Int?,
        suppressed: Bool
    ) {
        let nsError = error.map { $0 as NSError }
        AppLog.info("connectivity", suppressed ? "reachability flip suppressed" : "reachability transition", [
            "oldState": oldState ? "online" : "offline",
            "newState": newState ? "online" : "offline",
            "source": source,
            "endpoint": endpoint ?? "-",
            "errorDomain": nsError?.domain ?? "-",
            "errorCode": nsError.map { String($0.code) } ?? "-",
            "latencyMs": latencyMs.map(String.init) ?? "-",
            "consecutiveFailures": String(consecutiveFailures),
        ])
    }

    private static func latency(since started: Date) -> Int {
        Int(Date().timeIntervalSince(started) * 1_000)
    }
}

extension ConnectionStore: LifecycleSuspendable {
    func suspendForBackground() {
        isActive = false
        probeTask?.cancel()
        probeTask = nil
    }

    func resumeForForeground() {
        isActive = true
        if !online { startRecoveryProbe() }
    }
}
