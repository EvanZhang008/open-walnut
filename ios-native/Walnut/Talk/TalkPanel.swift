import SwiftUI
import UIKit

/// The take on Walnut's own screen: a press of the Action Button while Walnut is
/// in front, or one that could not record from behind the app on screen (Live
/// Activities off, the microphone never allowed), which opens Walnut already
/// listening. The take shows here until it is sent. From behind, the take's Live
/// Activity shows it instead (`TalkToWalnutIntent`). A dictation always takes place
/// here, and ends on its page: the words, Send and Copy (`TalkReviewPage`).
///
/// It has a window of its own above Walnut's, so it covers any sheet that was
/// open (the work card's list, an approval) instead of waiting behind it.
@MainActor
final class TalkPanel {
    static let shared = TalkPanel()

    private var window: UIWindow?
    /// The window that had the keyboard and focus before the panel: it gets them back.
    private weak var previousKey: UIWindow?
    /// The window under the panel, hidden from VoiceOver while the panel shows.
    private weak var covered: UIWindow?
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
        model.kept = false
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
        // VoiceOver never leaves the panel for the screen it covers.
        covered = previousKey
        covered?.accessibilityElementsHidden = true
        UIAccessibility.post(notification: .screenChanged, argument: host.view)
        // Leaving Walnut with nothing listening closes it: opened hours later, Walnut is as it
        // was. A dictation's page stays: its words wait there for Send or Copy (the person
        // may have gone to look something up), and are kept in the list anyway.
        leaving = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                let talk = TalkSession.shared
                // A dictation still getting its words keeps its panel too: they open on it.
                let dictationAhead = talk.destination == .dictation && talk.isBusy
                guard let self, talk.phase != .listening, !talk.isReviewing, !dictationAhead else { return }
                self.hide()
            }
        }
        AppLog.info("talk", "panel shown", [:])
        return true
    }

    func showError(_ message: String) {
        model.error = message
    }

    /// The page closed with neither Send nor Copy: say where the words wait, then go.
    func showKept() {
        model.kept = true
        hide(after: 2)
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
        // "Saved for later" closes on its own clock.
        guard !model.kept else { return }
        closing?.cancel()
        closing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.model.error == nil, !self.model.kept,
                  TalkSession.shared.phase == .idle else { return }
            self.close()
        }
    }

    private func close() {
        guard let window else { return }
        if let leaving { NotificationCenter.default.removeObserver(leaving) }
        leaving = nil
        window.isHidden = true
        self.window = nil
        covered?.accessibilityElementsHidden = false
        covered = nil
        model.error = nil
        model.kept = false
        previousKey?.makeKey()
        previousKey = nil
    }
}

@MainActor
@Observable
final class TalkPanelModel {
    var error: String?
    /// The dictation's page was closed with neither button: a moment saying where the
    /// words are, then the panel goes.
    var kept = false
}

struct TalkPanelView: View {
    let talk: TalkSession
    let model: TalkPanelModel
    let close: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if model.error == nil, case .review(let words) = talk.phase {
                // One page for a dictation: its words, Send and Copy, nothing else
                // (the user, 2026-11-11: "just one page that can send and can copy").
                TalkReviewPage(talk: talk, words: words, close: close)
            } else {
                status
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Under the keyboard too: Walnut's tab bar showed through it while editing.
        .background(Color(uiColor: .systemBackground).ignoresSafeArea(.all))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("talk.panel")
        .onChange(of: talk.phase) { _, phase in
            switch phase {
            // A failure to start belongs to the press that caused it, not the take after it.
            case .starting: model.error = nil
            // A sent (or copied) take shows its words a moment, then Walnut is as it was.
            case .sent, .copied: TalkPanel.shared.hide(after: 2)
            // Nothing sent: long enough to read why; the take stays on the Live Activity
            // and in Settings when it is kept.
            case .notSent: TalkPanel.shared.hide(after: 8)
            // Dropped (a take cancelled from the Live Activity, a dictation's page closed):
            // nothing left to show. A take that could not start is idle too, and its
            // reason stays up until Close.
            case .idle: TalkPanel.shared.hideUnlessSaying(after: 0.5)
            default: break
            }
        }
    }

    /// Every state but the dictation's page: one symbol, one line, what to do.
    private var status: some View {
        VStack(spacing: 0) {
            Spacer()
            ZStack {
                Circle()
                    .fill(tone.opacity(0.13))
                    .frame(width: 128, height: 128)
                symbol
                    .font(.system(size: 50, weight: .medium))
                    .foregroundStyle(tone)
            }
            .accessibilityHidden(true)
            Text(title)
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.top, 28)
                .accessibilityIdentifier("talk.panel.title")
            if let detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(6)
                    .padding(.top, 8)
                    .accessibilityIdentifier("talk.panel.detail")
            }
            Spacer()
            controls
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // While it listens the whole screen ends the take, easy to hit without looking (the
        // user, 2026-11-07: "the listening screen, tap it and it sends"); Cancel keeps its button.
        .contentShape(Rectangle())
        .onTapGesture { if model.error == nil, talk.phase == .listening { talk.finishSoon(source: "panel-tap") } }
    }

    @ViewBuilder
    private var symbol: some View {
        if model.error != nil {
            Image(systemName: "exclamationmark.triangle.fill")
        } else if model.kept {
            Image(systemName: "tray.and.arrow.down")
        } else {
            switch talk.phase {
            case .listening:
                Image(systemName: "waveform").symbolEffect(.variableColor.iterative, options: .repeating)
            case .starting, .transcribing, .sending:
                Image(systemName: "ellipsis").symbolEffect(.variableColor.iterative, options: .repeating)
            case .sent:
                Image(systemName: "checkmark")
            case .copied:
                Image(systemName: "doc.on.doc")
            case .notSent(let reason, let kept):
                Image(systemName: kept && TalkReason.goesOutLater(reason) ? "clock.arrow.circlepath" : "exclamationmark.triangle.fill")
            case .idle, .review:
                Image(systemName: "waveform")
            }
        }
    }

    private var tone: Color {
        if model.error != nil { return TalkTone.red }
        if model.kept { return Color.accentColor }
        switch talk.phase {
        case .listening: return TalkTone.orange
        case .sent, .copied: return TalkTone.green
        case .notSent(let reason, let kept): return kept && TalkReason.goesOutLater(reason) ? TalkTone.orange : TalkTone.red
        default: return .secondary
        }
    }

    private var dictating: Bool { talk.destination == .dictation }

    private var title: String {
        if model.error != nil { return "Couldn't start listening" }
        if model.kept { return "Saved for later" }
        switch talk.phase {
        case .starting: return "Opening the microphone"
        case .listening: return "Listening"
        case .transcribing: return "Getting your words"
        case .sending: return "Sending to your CEO"
        case .sent: return "Sent to your CEO"
        case .copied: return "Copied"
        case .notSent(let reason, let kept):
            if dictating { return "Couldn't get your words" }
            return kept && TalkReason.goesOutLater(reason) ? "Waiting to send" : "Not sent"
        case .idle, .review: return dictating ? "Dictate" : "Talk to Walnut"
        }
    }

    private var detail: String? {
        if let error = model.error { return error }
        if model.kept { return "Your words are in Settings, Action Button, to send or copy." }
        switch talk.phase {
        case .listening:
            return dictating
                ? "Tap anywhere when you're done, or press the Action Button again."
                : "Tap anywhere to send, or press the Action Button again."
        case .sent(let words): return "\u{201C}\(TalkSession.preview(words))\u{201D}"
        case .copied: return "Paste it anywhere."
        case .notSent(let reason, let kept):
            guard kept else { return reason }
            if dictating { return reason + " It is kept in Settings, Action Button." }
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
            // Stacked at the accessibility text sizes: side by side, "Cancel" breaks in two.
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
            layout {
                Button { Task { await talk.cancel(source: "panel-cancel"); close() } } label: {
                    Text("Cancel").font(.headline).frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.bordered)
                // Label-coloured words on the grey fill: secondary grey read as disabled.
                .tint(.primary)
                .accessibilityIdentifier("talk.panel.cancel")
                Button { talk.finishSoon(source: "panel-send") } label: {
                    Text(dictating ? "Done" : "Send").font(.headline).foregroundStyle(TalkTone.onProminent)
                        .frame(maxWidth: .infinity, minHeight: 56)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("talk.panel.send")
            }
            .buttonBorderShape(.roundedRectangle(radius: 16))
        } else if busy || closesItself {
            // The symbol above already moves while it works, and a confirmation goes by
            // itself: no second spinner, no Close to tap.
            Color.clear.frame(height: 56)
        } else {
            Button(action: close) {
                Text("Close").font(.headline).frame(maxWidth: .infinity, minHeight: 56)
            }
            .buttonStyle(.bordered)
            .tint(.primary)
            .buttonBorderShape(.roundedRectangle(radius: 16))
            .accessibilityIdentifier("talk.panel.close")
        }
    }

    /// Sent, Copied and Saved for later say it and go on their own.
    private var closesItself: Bool {
        guard model.error == nil else { return false }
        if model.kept { return true }
        switch talk.phase {
        case .sent, .copied: return true
        // Waiting to send goes out by itself, and its panel goes on its own clock.
        case .notSent(let reason, let kept): return kept && !dictating && TalkReason.goesOutLater(reason)
        default: return false
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

/// A dictation's page: the words as heard, to read or correct, then Send (to the CEO chat)
/// or Copy (to paste anywhere). The close button keeps them in the list.
struct TalkReviewPage: View {
    let talk: TalkSession
    let close: () -> Void
    @State private var text: String
    @State private var copyFailed = false
    @FocusState private var editing: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The close button's circle, growing with the text size.
    @ScaledMetric(relativeTo: .body) private var closeSize: CGFloat = 34

    init(talk: TalkSession, words: String, close: @escaping () -> Void) {
        self.talk = talk
        self.close = close
        _text = State(initialValue: words)
    }

    private var empty: Bool { !TalkSession.hasWords(text) }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Your words")
                    // At the accessibility sizes the words get the room, not the title.
                    .font(typeSize.isAccessibilitySize ? .headline : .title3.weight(.semibold))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Button {
                    talk.closeReview(text)
                    TalkPanel.shared.showKept()
                } label: {
                    Image(systemName: "xmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: closeSize, height: closeSize)
                        .background(Circle().fill(Color(uiColor: .tertiarySystemFill)))
                        // The circle stays small; the place a finger lands is the 44 pt minimum.
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
                .accessibilityHint("Keeps your words in Settings, Action Button.")
                .accessibilityIdentifier("talk.review.close")
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            // A tap on the title row puts the keyboard away (Return adds a line).
            .contentShape(Rectangle())
            .onTapGesture { editing = false }
            // Sized to the words (a one-line take is a one-line field), growing as they
            // grow, then scrolling inside; the buttons sit right under it.
            TextField("Type your words", text: $text, axis: .vertical)
                .font(.title3)
                .lineSpacing(4)
                .lineLimit(3...14)
                .focused($editing)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                // A field: it reads as text to correct, not only to read.
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color(uiColor: .secondarySystemBackground))
                )
                .padding(.horizontal, 20)
                .padding(.top, 12)
                .padding(.bottom, 16)
                .accessibilityLabel("Edit your words")
                .accessibilityIdentifier("talk.review.text")
            // The buttons stay at the bottom, under the thumb.
            Spacer(minLength: 0)
            if copyFailed {
                Text("iOS didn't take the words. Try Copy again.")
                    .font(.footnote)
                    .foregroundStyle(TalkTone.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("talk.review.copyFailed")
            }
            // Side by side; stacked at the accessibility text sizes, where "Send to CEO"
            // would be cut short beside Copy.
            Group {
                if typeSize.isAccessibilitySize {
                    VStack(spacing: 10) { sendButton; copyButton }
                } else {
                    HStack(spacing: 12) { copyButton; sendButton }
                }
            }
            // The buttons keep their full height (their words wrap, never cut short); with
            // the keyboard up the words' field gives up the room.
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .onChange(of: text) { _, words in
            copyFailed = false
            // On disk as typed: iOS may end Walnut at any moment, and the list, a reopened
            // page and a later Send all take what the person left.
            talk.keepReviewWords(words)
        }
        // iOS may end Walnut while it is away: the words keep the person's corrections. The
        // page lives in the panel's own window, outside any SwiftUI scene, so it hears the
        // app leave from UIKit rather than from the scene phase.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            talk.keepReviewWords(text)
        }
        // VoiceOver moves to the page that replaced the listening screen.
        .onAppear { UIAccessibility.post(notification: .screenChanged, argument: nil) }
    }

    private var copyButton: some View {
        Button {
            editing = false
            // A second tap after the words went (a quick double tap, VoiceOver) is no failure.
            guard talk.isReviewing else { return }
            copyFailed = !talk.copyReview(text)
            UINotificationFeedbackGenerator().notificationOccurred(copyFailed ? .error : .success)
        } label: {
            buttonLabel("Copy", systemImage: "doc.on.doc")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 16))
        .disabled(empty)
        // One label, no separate one for the icon.
        .accessibilityLabel("Copy")
        .accessibilityIdentifier("talk.review.copy")
    }

    /// Icon beside the words; at the accessibility sizes the icon sits above them, so a
    /// wrapped "Send to CEO" stays centred instead of hanging under the arrow.
    @ViewBuilder
    private func buttonLabel(_ title: String, systemImage: String) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(spacing: 4) {
                Image(systemName: systemImage)
                Text(title).multilineTextAlignment(.center)
            }
            .padding(.vertical, 6)
        } else {
            Label(title, systemImage: systemImage)
        }
    }

    private var sendButton: some View {
        Button {
            editing = false
            let words = text
            Task { await talk.sendReview(words) }
        } label: {
            buttonLabel("Send to CEO", systemImage: "arrow.up")
                .font(.headline)
                .foregroundStyle(empty ? Color.secondary : TalkTone.onProminent)
                .frame(maxWidth: .infinity, minHeight: 56)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.roundedRectangle(radius: 16))
        .disabled(empty)
        .accessibilityLabel("Send to CEO")
        .accessibilityIdentifier("talk.review.send")
    }
}
