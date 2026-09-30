import SwiftUI

/// Re-reads a letter while one of its replies is on record but its delivery is
/// still running, so "Sending to ..." turns into what happened without the human
/// reopening the letter.
///
/// Why (2026-09-29 gate, P1-A): the server's route deadline answered 504 while
/// the delivery of an already-threaded reply was still running. The app found
/// the reply on record, dropped its "Sending" bubble, and showed the turn with
/// no status line at all; nothing read the letter again, so "Sent" appeared
/// only after a reopen. A current server records the turn with a `pending`
/// delivery and answers 202; an older one records nothing until the attempt
/// ends. Either way the phone now knows the outcome is still to come and asks
/// again, on a bounded backoff. The inbox has no live push of letter updates to
/// the app, so this is the only way the outcome arrives.
///
/// When the bound runs out the reader gives up waiting (`giveUp`), and the line
/// says "Not confirmed" with its Retry, which is safe: it reuses the reply's id.
/// Giving up is not the end of looking, though: an outcome that lands later
/// (the r4 gate watched one settle 8.6s after the give-up, while the line kept
/// saying "Not confirmed") is picked up by a slow re-read every minute while the
/// letter is open (`lateKey`), and by one when the app comes back to the
/// foreground.
struct LetterDeliveryWatch: ViewModifier {
    /// The turns waiting for their outcome, joined; "" when none. A change (one
    /// settles, a new one appears) starts the backoff again for what is left.
    let waitingKey: String
    /// What is still unknown after the backoff gave up (turns shown as "Not
    /// confirmed", a reply whose answer was lost), joined; "" when none.
    let lateKey: String
    let reload: () async -> Void
    let giveUp: () -> Void

    @Environment(\.scenePhase) private var scenePhase

    /// Seconds between re-reads: 60s in all before giving up.
    static let delays: [Double] = [2, 4, 8, 16, 30]
    /// Seconds between the slow re-reads after that.
    static let lateInterval: Double = 60

    func body(content: Content) -> some View {
        content
            .task(id: waitingKey) {
                guard !waitingKey.isEmpty else { return }
                let scale = Self.delayScale
                for delay in Self.delays {
                    try? await Task.sleep(for: .seconds(delay * scale))
                    if Task.isCancelled { return }
                    await reload()
                    // The read settled something (or a new send joined): the task
                    // for the new key takes over.
                    if Task.isCancelled { return }
                }
                AppLog.info("inbox", "letter reply delivery never reported back, showing it as not confirmed", [
                    "turns": waitingKey,
                ])
                giveUp()
            }
            .task(id: lateKey) {
                guard !lateKey.isEmpty else { return }
                let interval = Self.lateSeconds
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(interval))
                    if Task.isCancelled { return }
                    await reload()
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active, !(waitingKey.isEmpty && lateKey.isEmpty) else { return }
                AppLog.info("inbox", "letter reply outcome still open, re-reading on foreground", [
                    "waiting": waitingKey, "late": lateKey,
                ])
                Task { await reload() }
            }
    }

    /// DEBUG only: `-walnut.deliveryRecheckScale 0.1` shortens every delay, so a
    /// UI test can reach the give-up state without waiting a minute.
    private static var delayScale: Double {
        #if DEBUG
        let scale = UserDefaults.standard.double(forKey: "walnut.deliveryRecheckScale")
        if scale > 0 { return scale }
        #endif
        return 1
    }

    /// The slow re-read's interval. DEBUG: `-walnut.deliveryLateSeconds N` sets
    /// it outright (a foreground test sets it past the test), else it follows
    /// the backoff's scale.
    private static var lateSeconds: Double {
        #if DEBUG
        let seconds = UserDefaults.standard.double(forKey: "walnut.deliveryLateSeconds")
        if seconds > 0 { return seconds }
        #endif
        return lateInterval * delayScale
    }
}
