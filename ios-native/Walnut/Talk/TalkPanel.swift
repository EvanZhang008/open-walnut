import SwiftUI
import UIKit

/// The screen a press of the Action Button opens: Walnut comes forward already
/// listening, and the take shows here until it is sent.
///
/// iOS lets no app start recording while it is not on screen (a privacy rule;
/// only calling apps are exempt), so the shortcut opens Walnut and records in
/// front instead of in the background. Build 160 tried the background and every
/// press was refused with "Audio is in use by another app".
///
/// It has a window of its own above Walnut's, so it covers any sheet that was
/// open (the work card's list, an approval) instead of waiting behind it.
@MainActor
final class TalkPanel {
    static let shared = TalkPanel()

    private var window: UIWindow?
    /// The window that had the keyboard and focus before the panel: it gets them back.
    private weak var previousKey: UIWindow?
    private var closing: Task<Void, Never>?
    private var leaving: NSObjectProtocol?
    /// Why the take could not start, said on the panel instead of an iOS alert.
    private let model = TalkPanelModel()

    var isShown: Bool { window != nil }

    /// Show the panel over whatever Walnut shows. False when no window scene is
    /// in front to show it in.
    @discardableResult
    func show() -> Bool {
        closing?.cancel()
        model.error = nil
        if window != nil { return true }
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive })
        else { return false }
        // A keyboard open in the chat would sit over Send and Cancel.
        previousKey = scene.windows.first(where: \.isKeyWindow)
        previousKey?.endEditing(true)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert
        let host = UIHostingController(rootView: TalkPanelView(talk: .shared, model: model) { [weak self] in self?.hide() })
        host.view.backgroundColor = .clear
        // VoiceOver stays on the panel, not the screen under it.
        host.view.accessibilityViewIsModal = true
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        UIAccessibility.post(notification: .screenChanged, argument: host.view)
        // Leaving Walnut with nothing listening closes it: opened hours later, Walnut is as it was.
        leaving = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, TalkSession.shared.phase != .listening else { return }
                self.hide()
            }
        }
        AppLog.info("talk", "panel shown", [:])
        return true
    }

    func showError(_ message: String) {
        model.error = message
    }

    /// Close it now, or `after` seconds from now unless it is shown again meanwhile.
    func hide(after delay: TimeInterval = 0) {
        closing?.cancel()
        closing = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled, let self else { return }
            self.close()
        }
    }

    /// Close it once nothing is going on and it says no reason a take could not start.
    func hideUnlessSaying(after delay: TimeInterval) {
        closing?.cancel()
        closing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.model.error == nil, TalkSession.shared.phase == .idle else { return }
            self.close()
        }
    }

    private func close() {
        guard let window else { return }
        if let leaving { NotificationCenter.default.removeObserver(leaving) }
        leaving = nil
        window.isHidden = true
        self.window = nil
        model.error = nil
        previousKey?.makeKey()
        previousKey = nil
    }
}

@MainActor
@Observable
final class TalkPanelModel {
    var error: String?
}

struct TalkPanelView: View {
    let talk: TalkSession
    let model: TalkPanelModel
    let close: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            symbol
                .font(.system(size: 64, weight: .regular))
                .foregroundStyle(tone)
                .accessibilityHidden(true)
            Text(title)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("talk.panel.title")
            if let detail {
                Text(detail)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(6)
                    .accessibilityIdentifier("talk.panel.detail")
            }
            Spacer()
            controls
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("talk.panel")
        .onChange(of: talk.phase) { _, phase in
            switch phase {
            // A failure to start belongs to the press that caused it, not the take after it.
            case .starting: model.error = nil
            // A sent take shows its words a moment, then Walnut is as it was.
            case .sent: TalkPanel.shared.hide(after: 2)
            // Nothing sent: long enough to read why; the take stays on the Live Activity
            // and in Settings when it is kept.
            case .notSent: TalkPanel.shared.hide(after: 8)
            // Dropped (a take cancelled from the Live Activity): nothing left to show. A take
            // that could not start is idle too, and its reason stays up until Close.
            case .idle: TalkPanel.shared.hideUnlessSaying(after: 0.5)
            default: break
            }
        }
    }

    @ViewBuilder
    private var symbol: some View {
        if model.error != nil {
            Image(systemName: "exclamationmark.triangle.fill")
        } else {
            switch talk.phase {
            case .listening:
                Image(systemName: "waveform").symbolEffect(.variableColor.iterative, options: .repeating)
            case .starting, .transcribing, .sending:
                Image(systemName: "arrow.up.circle")
            case .sent:
                Image(systemName: "checkmark.circle.fill")
            case .notSent(let reason, let kept):
                Image(systemName: kept && TalkReason.goesOutLater(reason) ? "clock.arrow.circlepath" : "exclamationmark.triangle.fill")
            case .idle:
                Image(systemName: "waveform")
            }
        }
    }

    private var tone: Color {
        if model.error != nil { return TalkTone.red }
        switch talk.phase {
        case .listening: return TalkTone.orange
        case .sent: return TalkTone.green
        case .notSent(let reason, let kept): return kept && TalkReason.goesOutLater(reason) ? TalkTone.orange : TalkTone.red
        default: return .secondary
        }
    }

    private var title: String {
        if model.error != nil { return "Couldn't start listening" }
        switch talk.phase {
        case .starting: return "Opening the microphone"
        case .listening: return "Listening"
        case .transcribing: return "Getting your words"
        case .sending: return "Sending to your CEO"
        case .sent: return "Sent to your CEO"
        case .notSent(let reason, let kept):
            return kept && TalkReason.goesOutLater(reason) ? "Waiting to send" : "Not sent"
        case .idle: return "Talk to Walnut"
        }
    }

    private var detail: String? {
        if let error = model.error { return error }
        switch talk.phase {
        case .listening: return "Say anything. Pause, press the Action Button again, or tap Send."
        case .sent(let words): return "\u{201C}\(TalkSession.preview(words))\u{201D}"
        case .notSent(let reason, let kept):
            guard kept else { return reason }
            if TalkReason.goesOutLater(reason) {
                return reason + " It goes to your CEO by itself the next time Walnut reaches your server."
            }
            return reason + " It is kept in Settings, Action Button, to send again."
        default: return nil
        }
    }

    @ViewBuilder
    private var controls: some View {
        if model.error == nil, talk.phase == .listening {
            HStack(spacing: 12) {
                Button { Task { await talk.cancel(source: "panel-cancel"); close() } } label: {
                    Text("Cancel").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("talk.panel.cancel")
                Button { talk.finishSoon(source: "panel-send") } label: {
                    Text("Send").foregroundStyle(TalkTone.onProminent).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("talk.panel.send")
            }
            .controlSize(.large)
        } else if busy {
            ProgressView().controlSize(.large)
        } else {
            Button(action: close) {
                Text("Close").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .accessibilityIdentifier("talk.panel.close")
        }
    }

    private var busy: Bool {
        guard model.error == nil else { return false }
        switch talk.phase {
        case .starting, .transcribing, .sending: return true
        default: return false
        }
    }
}
