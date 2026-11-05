import Foundation
import Network

/// Sends what Talk to Walnut kept as soon as the phone is back on a network,
/// while Walnut runs: the person should not have to open the list and tap
/// Resend after a take recorded in a lift or on a plane.
@MainActor
final class TalkNetworkWatch {
    static let shared = TalkNetworkWatch()
    private var monitor: NWPathMonitor?
    private var wasUp: Bool?

    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            let up = path.status == .satisfied
            Task { @MainActor in TalkNetworkWatch.shared.pathChanged(up: up) }
        }
        monitor.start(queue: DispatchQueue(label: "dev.openwalnut.talk-path", qos: .utility))
        self.monitor = monitor
    }

    /// Only a change from down to up resends; the first reading is a baseline.
    func pathChanged(up: Bool) {
        defer { wasUp = up }
        guard up, wasUp == false else { return }
        Task { await TalkSession.shared.resendKept(source: "network-back") }
    }
}
