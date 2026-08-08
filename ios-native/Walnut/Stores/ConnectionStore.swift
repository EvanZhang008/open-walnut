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
    /// In-flight 401 confirmation probe (see handleUnauthorized) — coalesces the
    /// burst of 401s a single screen's parallel requests would otherwise raise.
    private var unauthorizedProbe: Task<Bool, Never>?
    private var isActive = true

    var isConfigured: Bool = AppConfig.isConfigured
    var serverURL: String = AppConfig.serverURL?.absoluteString ?? ""
    var deviceName: String = AppConfig.deviceName ?? ""
    var status: ServerStatus?
    /// false only after two consecutive REST transport failures.
    var online = true

    init() {
        LifecycleHub.shared.register(self)
        // A 401 does NOT immediately wipe the credential. It used to: "any 401
        // anywhere bounces the app back to setup" destroyed the Keychain token
        // on the FIRST one, and tokens are unrecoverable by design — so one
        // transient 401 (a request racing a locked Keychain read and going out
        // with no Authorization header, a proxy stripping the header, a cloud
        // box mid-restart) permanently unpaired a healthy phone and forced a
        // QR re-scan. Reported 2026-07-29 with the device still present in the
        // cloud's auth.json, proving nothing was actually revoked.
        //
        // Instead: re-probe /status with the SAME stored token. Only a second,
        // confirmed 401 means the token is genuinely revoked.
        NotificationCenter.default.addObserver(
            forName: WalnutAPI.unauthorizedNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.handleUnauthorized() }
        }
    }

    /// Confirm a 401 before treating the token as dead. Runs at most one probe
    /// at a time; a transport error is inconclusive and leaves pairing intact.
    private func handleUnauthorized() async {
        // Not while suspended: `disconnect()` below rewrites four observed
        // fields and tears every store down — a scene-driving cascade that must
        // not run in a background/prewarm process (P0-3). The 401 will be
        // re-raised by the first request after the app comes back.
        guard isConfigured, isActive, unauthorizedProbe == nil else { return }
        let probe = Task { [weak self] () -> Bool in
            guard let self else { return false }
            guard let url = AppConfig.serverURL?.absoluteString, let token = AppConfig.token, !token.isEmpty else {
                // No usable credential to re-check — the token really is gone.
                return true
            }
            do {
                _ = try await self.api.testStatus(serverURL: url, token: token)
                return false // token still valid: the 401 was transient
            } catch APIError.unauthorized {
                return true // confirmed revoked
            } catch {
                return false // network/proxy problem — inconclusive, stay paired
            }
        }
        unauthorizedProbe = probe
        let revoked = await probe.value
        unauthorizedProbe = nil
        guard isActive else { return }
        if revoked {
            AppLog.error("auth", "device token confirmed revoked — returning to setup", [:])
            disconnect()
        } else {
            AppLog.info("auth", "ignored transient 401 — token still valid", [:])
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
        // Tell the server what this device IS, so the console shows the model
        // rather than just the name typed during pairing.
        reportDeviceInfo()
    }

    /// Push model/OS/app version to the server. Fire-and-forget: this is
    /// cosmetic metadata and must never block or fail a connection.
    ///
    /// Called at pair time AND on every launch — the launch call is what
    /// backfills devices paired before this existed.
    func reportDeviceInfo() {
        guard isConfigured, isActive else { return }
        let model = DeviceIdentity.model
        let os = DeviceIdentity.os
        let name = DeviceIdentity.name
        let appVersion = DeviceIdentity.appVersion
        Task { [api] in
            do {
                try await api.reportDeviceInfo(model: model, os: os, deviceName: name, appVersion: appVersion)
            } catch {
                AppLog.info("auth", "device info report skipped", ["error": String(describing: error)])
            }
        }
    }

    func refreshStatus() async {
        guard isConfigured, isActive else { return }
        let started = Date()
        do {
            let probed = try await api.status()
            // Backgrounded mid-probe: settle silently rather than driving an
            // observable update from a non-active process (P0-3).
            guard isActive, !Task.isCancelled else { return }
            status = probed
            reportReachability(true, source: "status-rest", endpoint: "/api/v1/status", latencyMs: Self.latency(since: started))
        } catch let error as APIError {
            guard !error.isCancelled, isActive else { return }
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
            // resetting the counter WHILE ALREADY ONLINE would keep the gate
            // from ever tripping.
            //
            // But an SSE-driven offline→online recovery MUST reset it. The gate
            // means "two consecutive failures since the last known-good", and
            // leaving a stale count of 2+ standing after we declared ourselves
            // online degraded it into a 1-failure hair trigger: the very next
            // REST hiccup flipped the whole app offline (and disabled the chat
            // composer) with no second sample.
            if !isSSE || !oldState { consecutiveFailures = 0 }
            // Equality-gated (audit OBS-6): every successful REST call lands
            // here, and `online` is read by 7+ views across stores. The
            // @Observable macro happens to suppress same-value scalar writes
            // on this SDK (see ObservationSemanticsProbeTests), but the gate
            // makes the invariant structural, not toolchain-dependent.
            if !online { online = true }
        } else if !isSSE {
            consecutiveFailures += 1
            if consecutiveFailures >= 2, online { online = false }
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
    ///
    /// Disconnect must TEAR DOWN every other subsystem too, not just clear this
    /// store: ChatStore's SSE stream, an open session stream, and the recovery
    /// probes all keep running against a server we no longer have a token for
    /// (they then 401-storm, and a 401 storm is what the transient-401 probe
    /// exists to survive). Fanning out through the hub is the one path that
    /// reaches all registered participants. `teardownAll` (NOT `suspendAll`) so
    /// the hub doesn't latch "suspended": the app is still in the foreground, so
    /// no `.active` transition is coming to clear that latch, and stores
    /// registered after a re-pair would be born dead.
    ///
    /// `DiskCache.clearAll()` is a recursive directory delete — it now hops to
    /// the cache's own IO queue instead of running on the MainActor here.
    func disconnect() {
        probeTask?.cancel()
        probeTask = nil
        LifecycleHub.shared.teardownAll()
        AppConfig.clear()
        DiskCache.clearAll()
        isConfigured = false
        serverURL = ""
        deviceName = ""
        status = nil
        consecutiveFailures = 0
        online = true
        // This store itself must stay live: SetupView drives connect() through
        // it, and the fan-out above just told every participant (us included)
        // to stand down.
        isActive = true
    }

    private func startRecoveryProbe() {
        guard probeTask == nil, isConfigured, isActive else { return }
        // A background/prewarm launch must not start probing the network before
        // the app is ever shown (P0-2); the probe's own loop then keeps it
        // parked whenever the app leaves active.
        guard LaunchGate.shared.hasActivated else {
            LaunchGate.shared.whenActive { [weak self] in self?.startRecoveryProbe() }
            return
        }
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
                    let probed = try await self.api.status()
                    // Suspended mid-probe: don't publish into a store whose
                    // process is no longer active (P0-3).
                    guard !Task.isCancelled, self.isActive else { return }
                    self.status = probed
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
