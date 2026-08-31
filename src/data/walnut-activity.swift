// walnut-activity — outside-activity sampler for Open Walnut's time tracking.
//
// Answers one question every 5 seconds: which Mac app is the user actually in
// right now, and (for a browser) which SITE. That is what lets the time panel
// split a day into inside-Walnut vs outside-Walnut time.
//
// Subcommands:
//   stream   long-running; ONE NDJSON line every 5s on stdout:
//            {"ts":"2026-08-29T10:04:12","app":"Slack","bundleId":"…",
//             "idleSecs":3.2,"locked":false,"host":"github.com"}
//            `host` only for a known browser; `browserErr":"permission"` when
//            the Automation grant is missing. Exits on a closed stdout.
//   status   {"ok":true,"version":"v1"} and exit 0 (Permission Doctor parity).
//
// PRIVACY: only the HOST of the active tab ever leaves this process — no
// scheme, path, query or credentials, and nothing at all for a non-browser app.
// A page title is never read.
//
// TCC: the app/idle/lock signals need no permission at all. Reading a browser's
// active tab is an Apple Event, which needs the user's one-time Automation
// grant per browser. That grant keys to THIS binary (see
// reexecDisclaimedIfNeeded), not to whatever launched Walnut.
//
// Compiled lazily by src/core/time-tracking/outside-collector.ts via
// `xcrun swiftc -O` into WALNUT_HOME/cache (same pattern as walnut-calendar).

import AppKit
import CoreGraphics
import Darwin
import Foundation

// v2: the wrapper forwards a stop signal to the disclaimed inner process, the
// inner exits when it is orphaned, and EVERY Apple Event error is throttled (not
// just "not authorized"). Before v2, stopping the helper killed the wrapper and
// left the inner sampling forever — one orphan per off→on toggle.
//
// v3: the inter-tick wait SERVICES THE RUN LOOP. NSWorkspace's frontmost app is a
// cache that AppKit refreshes when it processes workspace notifications, so a
// process that only slept between ticks reported whatever was frontmost at its
// first tick for the rest of its life: a helper spawned 8 hours earlier banked
// "loginwindow" all evening while the user typed in Walnut. Measured on this Mac,
// one long-running process, forced app switches: with Thread.sleep the value never
// moved off the app seen at startup (10/10 ticks); with run-loop servicing it
// tracked iTerm2 → Finder → iTerm2. NSWorkspace.runningApplications
// .first(isActive) is the SAME cache and was equally frozen — not a fallback.
let HELPER_VERSION = "v3"
/// One line per this many seconds. The server clamps banked duration itself, so
/// a slow tick can never inflate a day.
let SAMPLE_INTERVAL: TimeInterval = 5
/// After a "not authorized" Apple Event, don't ask that browser again for this
/// long: every attempt is a tccd round trip and a potential prompt.
let PERMISSION_RETRY_AFTER: TimeInterval = 600
/// Any OTHER scripting error (no window, app quitting, no dictionary) backs off
/// too — retrying every tick is a tccd round trip per 5 seconds — but far more
/// briefly, because opening a window should start attributing sites again soon.
let ERROR_RETRY_AFTER: TimeInterval = 60

// ── TCC self-responsibility ─────────────────────────────────────────────────
// TCC attributes an Apple Event to the RESPONSIBLE process — normally the top of
// the parent chain (Walnut.app, a terminal, a launchd job), whose Info.plist must
// carry NSAppleEventsUsageDescription or tccd refuses without prompting. That
// makes the grant break whenever the launcher changes. Fix: re-exec with
// responsibility DISCLAIMED so this binary is its own responsible process and
// tccd reads the usage key from our embedded __info_plist section.
//
// The re-exec means there are TWO processes: this wrapper (blocked in waitpid)
// and the inner streamer. A stop signal that reaches only the wrapper would kill
// the bookkeeper and leave the sampler running forever, so the wrapper forwards
// the signal on (below) and the inner also gives up when orphaned.

/// The disclaimed inner process, for the signal forwarder. Zero until spawned.
var innerPid: pid_t = 0

/// Async-signal-safe: one kill(), one _exit(). 143/130 are the conventional
/// "died from SIGTERM/SIGINT" codes, which the collector treats as a clean stop.
func forwardStopSignal(_ sig: Int32) {
    if innerPid > 0 { kill(innerPid, sig) }
    _exit(sig == SIGINT ? 130 : 143)
}

func reexecDisclaimedIfNeeded() {
    guard ProcessInfo.processInfo.environment["WALNUT_ACT_DISCLAIMED"] != "1" else { return }
    typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>?, Int32) -> Int32
    let RTLD_DEFAULT = UnsafeMutableRawPointer(bitPattern: -2)
    guard let sym = dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim") else { return }
    let setDisclaim = unsafeBitCast(sym, to: DisclaimFn.self)

    var attr: posix_spawnattr_t?
    guard posix_spawnattr_init(&attr) == 0 else { return }
    defer { posix_spawnattr_destroy(&attr) }
    guard setDisclaim(&attr, 1) == 0 else { return }

    let exePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
    var argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) }
    argv.append(nil)
    var env = ProcessInfo.processInfo.environment
    env["WALNUT_ACT_DISCLAIMED"] = "1"
    var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)

    var pid: pid_t = 0
    guard posix_spawn(&pid, exePath, nil, &attr, argv, envp) == 0 else { return } // fall back inline
    innerPid = pid
    // A signal arriving before this point kills the wrapper only; the inner's own
    // orphan check (streamForever) then ends it within one sample interval.
    signal(SIGTERM, forwardStopSignal)
    signal(SIGINT, forwardStopSignal)
    signal(SIGHUP, forwardStopSignal)
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    // WIFEXITED / WEXITSTATUS (Swift has no C macros)
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

// ── output ──────────────────────────────────────────────────────────────────

let localFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    f.timeZone = TimeZone.current
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

/// One NDJSON line, flushed immediately (the reader parses per line, and a
/// buffered helper would look hung). A closed stdout ends the process, which is
/// how an orphaned helper reaps itself when the server goes away.
func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
    var line = data
    line.append(0x0a)
    line.withUnsafeBytes { raw in
        var off = 0
        while off < raw.count {
            let n = write(1, raw.baseAddress!.advanced(by: off), raw.count - off)
            if n <= 0 {
                if errno == EINTR { continue }
                exit(0) // stdout gone: the server no longer wants samples
            }
            off += n
        }
    }
}

// ── signals that need no permission ─────────────────────────────────────────

/// Seconds since the last human input event, across the whole login session.
/// `kCGAnyInputEventType` is 0xFFFFFFFF, which is not a declared CGEventType
/// case; when the enum refuses it, fall back to the minimum over the concrete
/// input types (same answer, more calls).
let anyInputEventType = CGEventType(rawValue: ~0)
let inputEventTypes: [CGEventType] = [
    .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown,
    .rightMouseUp, .otherMouseDown, .mouseMoved, .leftMouseDragged, .rightMouseDragged,
    .scrollWheel,
]

func idleSeconds() -> Double {
    if let any = anyInputEventType {
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
    var best = Double.greatestFiniteMagnitude
    for t in inputEventTypes {
        best = min(best, CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: t))
    }
    return best == Double.greatestFiniteMagnitude ? 0 : best
}

/// The key is ABSENT while unlocked (not `false`), so only an explicit true counts.
func screenLocked() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as NSDictionary? else { return false }
    return (dict["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true
}

// ── browsers ────────────────────────────────────────────────────────────────

/// Bundle id → the AppleScript that returns the active tab's URL. Addressed by
/// `application id` rather than by name so a localized or renamed app still
/// resolves. An app absent from this map is never scripted: no host, silently.
let BROWSER_SCRIPTS: [String: String] = [
    "com.apple.Safari": "tell application id \"com.apple.Safari\" to return URL of front document",
    "com.google.Chrome": chromiumScript("com.google.Chrome"),
    "com.microsoft.edgemac": chromiumScript("com.microsoft.edgemac"),
    "com.brave.Browser": chromiumScript("com.brave.Browser"),
    "company.thebrowser.Browser": chromiumScript("company.thebrowser.Browser"),
    "com.vivaldi.Vivaldi": chromiumScript("com.vivaldi.Vivaldi"),
    "com.operasoftware.Opera": chromiumScript("com.operasoftware.Opera"),
]

func chromiumScript(_ bundleId: String) -> String {
    return "tell application id \"\(bundleId)\" to return URL of active tab of front window"
}

/// errAEEventNotPermitted — the user has not granted (or has refused) Automation.
let ERR_NOT_AUTHORIZED = -1743

var compiledScripts: [String: NSAppleScript] = [:]
/// Last failure per browser, and whether it was the permission one. EVERY error
/// backs off: a browser with no scriptable window used to be re-asked every tick.
var lastScriptError: [String: (at: Date, permission: Bool)] = [:]

enum TabLookup {
    case host(String)
    case notPermitted
    case unavailable
}

/// The HOST of the frontmost browser tab. Everything else about the URL is
/// dropped here, in-process, so no path or query can reach a log or a JSONL file.
func activeTabHost(bundleId: String) -> TabLookup {
    guard let source = BROWSER_SCRIPTS[bundleId] else { return .unavailable }
    if let last = lastScriptError[bundleId] {
        let waitFor = last.permission ? PERMISSION_RETRY_AFTER : ERROR_RETRY_AFTER
        if Date().timeIntervalSince(last.at) < waitFor {
            // Still backing off. A denial is reported every tick (the UI hint needs
            // it); anything else stays silent, exactly as if we had just asked.
            return last.permission ? .notPermitted : .unavailable
        }
    }
    let script = compiledScripts[bundleId] ?? NSAppleScript(source: source)
    guard let script else { return .unavailable }
    compiledScripts[bundleId] = script

    var error: NSDictionary?
    let result = script.executeAndReturnError(&error)
    if let error {
        let code = (error[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
        let permission = code == ERR_NOT_AUTHORIZED
        lastScriptError[bundleId] = (Date(), permission)
        // Anything other than a denial (no window, app quitting mid-read, a
        // browser without a dictionary) is nothing the user can act on: stay silent.
        return permission ? .notPermitted : .unavailable
    }
    lastScriptError[bundleId] = nil
    guard let raw = result.stringValue, let host = hostOnly(raw) else { return .unavailable }
    return .host(host)
}

/// Host of an absolute URL, lowercased, without `www.` and without userinfo.
/// Returns nil for anything without a real host (chrome://newtab, file://, "").
func hostOnly(_ urlString: String) -> String? {
    let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let comps = URLComponents(string: trimmed) else { return nil }
    guard let scheme = comps.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
    guard var host = comps.host?.lowercased(), !host.isEmpty else { return nil }
    if host.hasPrefix("www.") { host = String(host.dropFirst(4)) }
    return host.isEmpty ? nil : host
}

// ── sampling ────────────────────────────────────────────────────────────────

func sampleOnce() {
    let locked = screenLocked()
    let front = NSWorkspace.shared.frontmostApplication
    let bundleId = front?.bundleIdentifier
    var out: [String: Any] = [
        "ts": localFormatter.string(from: Date()),
        "app": front?.localizedName ?? "unknown",
        // Decimal, not Double: JSONSerialization prints a Double at full binary
        // precision (38.700000000000003), which is noise in every log line.
        "idleSecs": NSDecimalNumber(string: String(format: "%.1f", idleSeconds())),
        "locked": locked,
    ]
    if let bundleId { out["bundleId"] = bundleId }
    // A locked screen is discarded by the server anyway, and asking a browser
    // for its tab while the screen is locked is pointless work.
    if !locked, let bundleId, BROWSER_SCRIPTS[bundleId] != nil {
        switch activeTabHost(bundleId: bundleId) {
        case .host(let host): out["host"] = host
        case .notPermitted: out["browserErr"] = "permission"
        case .unavailable: break
        }
    }
    emit(out)
}

/// The wait between samples. Servicing the run loop is the whole point: it is
/// what lets AppKit deliver the workspace notifications that refresh
/// NSWorkspace.frontmostApplication (see the v3 note at the top of this file).
///
/// RunLoop.run(until:) returns IMMEDIATELY when the loop has no sources attached,
/// so a keep-alive timer is registered first and any early return still pays a
/// short sleep — otherwise the "wait" could become a busy spin.
func waitServicingRunLoop(until deadline: Date) {
    while deadline.timeIntervalSinceNow > 0 {
        RunLoop.current.run(until: deadline)
        let left = deadline.timeIntervalSinceNow
        if left > 0 { Thread.sleep(forTimeInterval: min(left, 0.2)) }
    }
}

func streamForever() -> Never {
    // A dead reader must end the helper, not kill it mid-write with a signal.
    signal(SIGPIPE, SIG_IGN)
    // Keeps the run loop from returning instantly when nothing else is attached.
    RunLoop.current.add(Timer(timeInterval: 3600, repeats: true) { _ in }, forMode: .default)
    var next = Date()
    while true {
        // Orphaned: our parent (the wrapper, or the walnut server when the
        // disclaim re-exec was unavailable) is gone, so nobody is reading these
        // samples and nobody will ever stop us. Third layer of the same
        // guarantee, after signal forwarding and the EPIPE check in emit().
        if getppid() == 1 { exit(0) }
        sampleOnce()
        next = next.addingTimeInterval(SAMPLE_INTERVAL)
        // Behind schedule (machine slept, helper starved): resync instead of
        // firing a burst of catch-up samples.
        if next.timeIntervalSinceNow > 0 { waitServicingRunLoop(until: next) } else { next = Date() }
    }
}

// ── main ────────────────────────────────────────────────────────────────────

let args = CommandLine.arguments
guard args.count >= 2 else {
    emit(["error": "usage: walnut-activity <stream|status>", "code": "usage"])
    exit(1)
}
// `status` is a constant answer: no Apple Events, so no re-exec and no prompt.
if args[1] == "status" {
    emit(["ok": true, "version": HELPER_VERSION])
    exit(0)
}
reexecDisclaimedIfNeeded()
switch args[1] {
case "stream":
    streamForever()
default:
    emit(["error": "unknown subcommand: \(args[1])", "code": "usage"])
    exit(1)
}
