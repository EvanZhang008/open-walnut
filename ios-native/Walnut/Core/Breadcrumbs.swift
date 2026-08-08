import Foundation
import SwiftUI
import UIKit

/// Automatic "what was the app doing" logging — the flight recorder's tape.
///
/// ## Why a heartbeat instead of N scattered log calls
///
/// `FreezeContext` already maintains an always-current, O(1)-to-write snapshot
/// of the app's state (screen, keyboard flips, draft size, history rows, live
/// turn size, memory, an 8-event crumb ring). Until now it was read exactly
/// ONCE — by `MainThreadWatchdog`, at freeze time. Every one of those pushes is
/// a fact we wanted in the field log, and re-instrumenting each push site with
/// its own `AppLog` call would have meant editing a dozen hot paths (some owned
/// by other work in flight) and paying a string format per keystroke.
///
/// So the tape is a periodic sample of that existing snapshot: one `debug` line
/// every `interval` while the app is in the foreground, carrying the whole
/// `ctx*` meta bag. That yields a minute-by-minute reconstruction of screens,
/// keyboard behavior, composer size, turn size and memory growth — including
/// crumbs pushed from code this file never touches — for the price of one
/// lock-guarded read per tick, off the main thread.
///
/// Discrete one-off events (memory warnings, scene transitions, screen changes)
/// still get their own line via `note` / `event`, because a 30 s sample can miss
/// a transient and because those are what you grep for first.
///
/// ## Main-thread discipline
///
/// The heartbeat timer runs on its own utility queue and only ever calls
/// `FreezeContext.snapshotMeta()` (documented safe off-main: locked scalars plus
/// a mach memory read) and `AppLog` (lock + disk queue). It must never hop to
/// the main queue — that would make it stop sampling during exactly the freezes
/// it exists to document.
enum Breadcrumbs {
    private static let queue = DispatchQueue(label: "dev.openwalnut.breadcrumbs", qos: .utility)
    private static let stateLock = NSLock()
    private static var timer: DispatchSourceTimer?
    private static var started = false
    private static var foreground = true
    /// Ticks emitted since the last state change — lets a quiescent app sample
    /// less often without losing the "still alive, still here" signal.
    private static var idleTicks = 0
    private static var lastFingerprint = ""

    /// Sampling period. 30 s ≈ 120 lines/hour of active foreground use, ~24 KB
    /// gzipped — affordable, and fine enough to bracket any user-visible event.
    private static let interval: TimeInterval = 30
    /// When nothing has changed, drop to one line every `quietFactor` ticks
    /// (5 min) so an app left open on one screen doesn't pad the log.
    private static let quietFactor = 10

    // MARK: - Lifecycle

    /// Call once at startup (main thread), after `FreezeContext.shared.start()`.
    static func start() {
        stateLock.lock()
        if started { stateLock.unlock(); return }
        started = true
        stateLock.unlock()

        // Every FreezeContext crumb — from ANY push site, including hot paths
        // this file never touches (send, append-draft, focus/blur, turn-end,
        // snapshot-seeded, repin-ring-break, voice-transcribed) — mirrors onto
        // the tape. The crumb ring holds 8; the log holds the whole session.
        FreezeContext.shared.setCrumbSink { name, count in
            AppLog.info("crumb", name, count.map { ["count": String($0)] })
        }

        // Memory pressure is a prime suspect in jetsam kills (0x8BADF00D) and
        // was previously invisible: the OS warns, the app ignores it, and the
        // next thing in the log is a crash from the following launch.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: nil
        ) { _ in
            FreezeContext.shared.note("memory-warning")
            AppLog.warn("memory", "system memory warning", [
                "memoryMB": String(FreezeContext.residentMemoryMB()),
            ])
            // A memory warning often precedes a kill by seconds — get the tape
            // off the device while there still is a process to send it.
            AppLog.shared.persistNow()
            AppLog.shared.uploadCritical()
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { _ in setForeground(false) }
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
        ) { _ in setForeground(true) }

        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now() + interval, repeating: interval)
        source.setEventHandler { tick() }
        source.resume()
        stateLock.lock()
        timer = source
        stateLock.unlock()
    }

    private static func setForeground(_ value: Bool) {
        stateLock.lock()
        foreground = value
        // Force the next tick to emit: the state around a transition is the
        // most interesting sample there is.
        idleTicks = quietFactor
        stateLock.unlock()
    }

    private static func tick() {
        stateLock.lock()
        let active = foreground
        stateLock.unlock()
        // Backgrounded = the process is frozen anyway; sampling would only
        // produce a burst of identical lines on resume.
        guard active else { return }

        let meta = FreezeContext.shared.snapshotMeta()
        // Fingerprint the fields a user action would move. Memory drifts on its
        // own, so it is deliberately NOT part of the identity — otherwise every
        // tick looks "changed" and the quiet path never engages.
        let fingerprint = [
            meta["ctxScreen"], meta["ctxKeyboard"], meta["ctxDraftChars"],
            meta["ctxHistoryRows"], meta["ctxLiveChars"], meta["ctxTrail"],
        ].map { $0 ?? "-" }.joined(separator: "|")

        stateLock.lock()
        let unchanged = fingerprint == lastFingerprint
        if unchanged {
            idleTicks += 1
        } else {
            lastFingerprint = fingerprint
            idleTicks = 0
        }
        let shouldEmit = !unchanged || idleTicks >= quietFactor
        if shouldEmit, unchanged { idleTicks = 0 }
        stateLock.unlock()

        guard shouldEmit else { return }
        AppLog.debug("heartbeat", unchanged ? "state (idle)" : "state", meta)
    }

    // MARK: - Discrete events

    /// A notable action: pushed to the freeze snapshot's crumb ring, which the
    /// installed sink mirrors onto the tape (so this does NOT log directly —
    /// doing both would double every crumb). `name` should be a literal and
    /// `count` a magnitude, so nothing here interpolates user content.
    static func note(_ name: String, _ count: Int? = nil) {
        FreezeContext.shared.note(name, count)
    }

    /// Scene phase transition (`active` / `inactive` / `background`). Logged
    /// with the current memory footprint — a background→active pair bracketing a
    /// jump is how a suspension-related leak shows itself.
    static func scenePhase(_ phase: String) {
        FreezeContext.shared.note("scene-\(phase)")
        AppLog.info("lifecycle", "scene phase", [
            "phase": phase,
            "memoryMB": String(FreezeContext.residentMemoryMB()),
        ])
    }

}
