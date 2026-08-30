/**
 * Global dictation: press the hotkey anywhere in macOS, speak, press it again,
 * and the transcription lands on the clipboard.
 *
 * Why this lives in the app and not in a script: recording the microphone needs
 * a TCC grant, and macOS only prompts for one on behalf of a signed app bundle
 * with NSMicrophoneUsageDescription (we have both). A helper CLI spawned from a
 * daemon or a third-party hotkey tool is silently denied instead of prompted, so
 * the app has to be the recorder. It also keeps Walnut self-contained: no extra
 * software for the user to install.
 *
 * Carbon's RegisterEventHotKey is deliberate too. It is the only system-wide
 * hotkey API that needs no Accessibility permission, unlike an NSEvent global
 * monitor, so the feature works the first time with nothing to approve.
 *
 * Double-tapping Fn is offered as a second trigger because it is the gesture
 * dictation users already know. It cannot go through the Carbon path: that API's
 * modifier mask has bits for Command, Shift, Option and Control only, with no Fn
 * bit, and a bare modifier is not a hotkey anyway. So it needs a global event
 * monitor, which needs Input Monitoring approval. That is why it is opt-in and
 * why ⌃⌥⌘D keeps working with nothing granted.
 *
 * Transcription reuses the normal server route (POST /api/stt/transcribe), so
 * dictation gets the same engine, the same vocabulary bias, and the same
 * recoverable history as the mic button in the web UI.
 */

import Cocoa
import AVFoundation
import Carbon.HIToolbox

/// Fired by the Carbon handler; the handler cannot capture Swift context.
private let dictationHotKeyID: UInt32 = 0x574E_4443 // 'WNDC'
private weak var activeDictation: GlobalDictation?

final class GlobalDictation: NSObject {
    /// Resolves the port the app's server is actually on (it can fall back).
    private let portProvider: () -> Int?
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var hud: DictationHUD?
    /// Hard cap so a hotkey pressed and forgotten cannot record forever.
    private var autoStopWork: DispatchWorkItem?
    private let maxRecordingSeconds: TimeInterval = 300

    /// Double-tap Fn support.
    private var fnMonitor: Any?
    private var lastFnPressAt: TimeInterval = 0
    /// Long enough to be comfortable, short enough that two unrelated Fn presses
    /// (Fn+arrow, brightness keys) do not read as one gesture.
    private let doubleTapWindow: TimeInterval = 0.45
    private static let doubleTapFnKey = "dictationDoubleTapFn"

    var isRecording: Bool { recorder?.isRecording ?? false }

    /// Opt-in because enabling it needs an Input Monitoring grant.
    static var doubleTapFnEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: doubleTapFnKey) }
        set { UserDefaults.standard.set(newValue, forKey: doubleTapFnKey) }
    }

    init(portProvider: @escaping () -> Int?) {
        self.portProvider = portProvider
        super.init()
    }

    // MARK: - Hotkey registration

    /// Registers Control-Option-Command-D system wide. Safe to call once at launch;
    /// a failure is logged and simply leaves the feature off (never fatal).
    func registerHotKey() {
        activeDictation = self
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                 eventKind: UInt32(kEventHotKeyPressed))
        let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hkID = EventHotKeyID()
            let err = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                                        EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &hkID)
            guard err == noErr, hkID.id == dictationHotKeyID else { return noErr }
            DispatchQueue.main.async { activeDictation?.toggle() }
            return noErr
        }, 1, &spec, nil, &eventHandler)
        guard installed == noErr else {
            DesktopLogger.shared.log("dictation_handler_failed", fields: ["status": String(installed)])
            return
        }

        let hkID = EventHotKeyID(signature: OSType(dictationHotKeyID), id: dictationHotKeyID)
        let mods = UInt32(controlKey | optionKey | cmdKey)
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_D), mods, hkID,
                                         GetApplicationEventTarget(), 0, &hotKeyRef)
        if status == noErr {
            DesktopLogger.shared.log("dictation_hotkey_registered", fields: ["keys": "ctrl-opt-cmd-D"])
        } else {
            // Most likely another app already owns this combination.
            DesktopLogger.shared.log("dictation_hotkey_failed", fields: ["status": String(status)])
        }
    }

    func unregisterHotKey() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if let handler = eventHandler { RemoveEventHandler(handler); eventHandler = nil }
        stopFnMonitor()
        activeDictation = nil
    }

    // MARK: - Double-tap Fn

    /// Starts watching for a double Fn tap if the user turned it on and macOS has
    /// granted Input Monitoring. Silent no-op otherwise, so ⌃⌥⌘D is unaffected.
    func startFnMonitorIfEnabled() {
        guard Self.doubleTapFnEnabled, fnMonitor == nil else { return }
        guard CGPreflightListenEventAccess() else {
            DesktopLogger.shared.log("dictation_fn_monitor_unauthorized", fields: [:])
            return
        }
        fnMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.flagsChanged]) { [weak self] event in
            self?.handleFlagsChanged(event)
        }
        DesktopLogger.shared.log("dictation_fn_monitor_started", fields: [:])
    }

    func stopFnMonitor() {
        if let monitor = fnMonitor { NSEvent.removeMonitor(monitor); fnMonitor = nil }
        lastFnPressAt = 0
    }

    /// Turns the gesture on or off, asking macOS for Input Monitoring the first
    /// time. Returns whether it is now actually listening.
    @discardableResult
    func setDoubleTapFn(_ enabled: Bool) -> Bool {
        Self.doubleTapFnEnabled = enabled
        guard enabled else {
            stopFnMonitor()
            return false
        }
        guard CGPreflightListenEventAccess() else {
            // Opens System Settings on the right pane. macOS only prompts once per
            // app version, so tell the user where to look either way.
            CGRequestListenEventAccess()
            showHUD("Allow Walnut under System Settings, Privacy and Security, Input Monitoring, then reopen Walnut",
                    style: .error, autoHide: 8)
            return false
        }
        startFnMonitorIfEnabled()
        return fnMonitor != nil
    }

    private func handleFlagsChanged(_ event: NSEvent) {
        // keyCode 63 is the physical Fn key. Filtering on it matters: arrow keys
        // and the F-row also carry .function in their modifier flags, so testing
        // the flag alone would fire on Fn+Left and friends.
        guard event.keyCode == 63 else { return }
        let flags = event.modifierFlags
        // Press, not release.
        guard flags.contains(.function) else { return }
        // A chord like Fn+Shift is someone reaching for a different shortcut.
        guard flags.intersection([.command, .option, .control, .shift]).isEmpty else { return }

        let now = event.timestamp
        if now - lastFnPressAt <= doubleTapWindow {
            lastFnPressAt = 0
            DispatchQueue.main.async { [weak self] in self?.toggle() }
            return
        }
        lastFnPressAt = now
    }

    // MARK: - Recording

    func toggle() {
        if isRecording { stopAndTranscribe() } else { startRecording() }
    }

    private func startRecording() {
        guard portProvider() != nil else {
            showHUD("Walnut server is not ready yet", style: .error, autoHide: 2.5)
            return
        }
        // Ask once; macOS shows its own prompt because the bundle declares
        // NSMicrophoneUsageDescription. A denial is reported rather than silent.
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard granted else {
                    self.showHUD("Microphone access denied — enable Walnut under System Settings, Privacy and Security, Microphone",
                                 style: .error, autoHide: 6)
                    return
                }
                self.beginCapture()
            }
        }
    }

    private func beginCapture() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("walnut-dictation-\(UUID().uuidString).m4a")
        // 16 kHz mono matches what the STT engines resample to anyway, so this
        // keeps the upload small without throwing away anything they would use.
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        do {
            let rec = try AVAudioRecorder(url: url, settings: settings)
            rec.isMeteringEnabled = true
            guard rec.record() else {
                showHUD("Could not start recording", style: .error, autoHide: 3)
                return
            }
            recorder = rec
            recordingURL = url
            showHUD("Listening… press the hotkey again to finish", style: .recording, autoHide: nil)
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, self.isRecording else { return }
                self.stopAndTranscribe()
            }
            autoStopWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + maxRecordingSeconds, execute: work)
            DesktopLogger.shared.log("dictation_started", fields: [:])
        } catch {
            showHUD("Could not start recording: \(error.localizedDescription)", style: .error, autoHide: 4)
        }
    }

    private func stopAndTranscribe() {
        autoStopWork?.cancel()
        autoStopWork = nil
        guard let rec = recorder, let url = recordingURL else { return }
        rec.stop()
        recorder = nil
        recordingURL = nil

        guard let port = portProvider() else {
            showHUD("Walnut server went away", style: .error, autoHide: 3)
            try? FileManager.default.removeItem(at: url)
            return
        }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else {
            showHUD("No audio captured", style: .error, autoHide: 3)
            try? FileManager.default.removeItem(at: url)
            return
        }
        try? FileManager.default.removeItem(at: url)
        DesktopLogger.shared.log("dictation_stopped", fields: ["bytes": String(data.count)])
        showHUD("Transcribing…", style: .working, autoHide: nil)
        transcribe(audio: data, port: port)
    }

    // MARK: - Transcription

    private func transcribe(audio: Data, port: Int) {
        guard let endpoint = URL(string: "http://127.0.0.1:\(port)/api/stt/transcribe") else { return }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // m4a is in the server's allowed-format list, and it converts with ffmpeg
        // exactly as it does for the browser's webm.
        let body: [String: Any] = ["audio": audio.base64EncodedString(), "format": "m4a"]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        // Generous: a cold model load plus a long clip. The HUD stays up meanwhile.
        req.timeoutInterval = 300

        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    DesktopLogger.shared.log("dictation_failed", fields: ["reason": error.localizedDescription])
                    self.showHUD("Transcription failed: \(error.localizedDescription)", style: .error, autoHide: 5)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
                guard status == 200 else {
                    let detail = json?["error"] as? String ?? "HTTP \(status)"
                    DesktopLogger.shared.log("dictation_failed", fields: ["reason": detail])
                    self.showHUD("Transcription failed: \(detail)", style: .error, autoHide: 5)
                    return
                }
                let text = (json?["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                guard !text.isEmpty else {
                    // The audio is still in Walnut's recording history for a Redo.
                    // Usually means the mic picked up near-silence, so say so here:
                    // an unlogged empty result is very hard to tell from a crash.
                    DesktopLogger.shared.log("dictation_empty", fields: [:])
                    self.showHUD("Nothing was transcribed — check the microphone input level",
                                 style: .error, autoHide: 4)
                    return
                }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                let preview = text.count > 60 ? String(text.prefix(60)) + "…" : text
                self.showHUD("Copied: \(preview)", style: .done, autoHide: 4)
                DesktopLogger.shared.log("dictation_copied", fields: ["chars": String(text.count)])
            }
        }.resume()
    }

    // MARK: - HUD

    private func showHUD(_ message: String, style: DictationHUD.Style, autoHide: TimeInterval?) {
        if hud == nil { hud = DictationHUD() }
        hud?.show(message, style: style, autoHide: autoHide)
    }
}

/**
 * Small floating status panel, shown near the top of the active screen.
 *
 * It is a non-activating panel on purpose: dictation is used while another app
 * has focus, and stealing focus to say "Listening…" would defeat the point.
 */
final class DictationHUD {
    enum Style {
        case recording, working, done, error

        var accent: NSColor {
            switch self {
            case .recording: return NSColor.systemRed
            case .working: return NSColor.systemGray
            case .done: return NSColor.systemGreen
            case .error: return NSColor.systemOrange
            }
        }
    }

    private var panel: NSPanel?
    private var label: NSTextField?
    private var dot: NSView?
    private var hideWork: DispatchWorkItem?

    func show(_ message: String, style: Style, autoHide: TimeInterval?) {
        buildIfNeeded()
        label?.stringValue = message
        dot?.layer?.backgroundColor = style.accent.cgColor
        layout()
        panel?.orderFrontRegardless()
        hideWork?.cancel()
        guard let seconds = autoHide else { return }
        let work = DispatchWorkItem { [weak self] in self?.panel?.orderOut(nil) }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    private func buildIfNeeded() {
        guard panel == nil else { return }
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 44),
                        styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isFloatingPanel = true
        p.level = .statusBar
        p.hidesOnDeactivate = false
        p.isOpaque = false
        p.backgroundColor = .clear
        p.ignoresMouseEvents = true
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let container = NSView(frame: p.contentView!.bounds)
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.windowBackgroundColor.withAlphaComponent(0.97).cgColor
        container.layer?.cornerRadius = 11
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor.separatorColor.cgColor
        container.layer?.shadowOpacity = 0.22
        container.layer?.shadowRadius = 10
        container.layer?.shadowOffset = CGSize(width: 0, height: -2)

        let d = NSView(frame: NSRect(x: 14, y: 18, width: 9, height: 9))
        d.wantsLayer = true
        d.layer?.cornerRadius = 4.5
        container.addSubview(d)
        dot = d

        let l = NSTextField(labelWithString: "")
        l.frame = NSRect(x: 31, y: 12, width: 315, height: 20)
        l.font = .systemFont(ofSize: 12.5)
        l.lineBreakMode = .byTruncatingTail
        container.addSubview(l)
        label = l

        p.contentView = container
        panel = p
    }

    /// Re-centres near the top of whichever screen currently has the mouse, so the
    /// HUD shows up where the user is working on a multi-display setup.
    private func layout() {
        guard let p = panel else { return }
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let frame = screen?.visibleFrame else { return }
        let size = p.frame.size
        p.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 18))
    }
}
