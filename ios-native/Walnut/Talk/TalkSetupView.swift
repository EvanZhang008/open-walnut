import AppIntents
import AVFoundation
import SwiftUI
import UIKit

/// Settings, Action Button: what Talk to Walnut does, a way to try it here, the
/// exact steps to put it on the Action Button (only the person can, in iOS
/// Settings), other places it runs, and anything it could not send.
struct TalkSetupView: View {
    @State private var talk = TalkSession.shared
    @State private var mic = TalkSession.systemMicAccess()
    @State private var tryError: String?
    @State private var showingUnsent = false
    @Environment(\.scenePhase) private var scenePhase

    private var allWait: Bool { talk.outbox.unsent.allSatisfy(TalkSession.waits) }

    var body: some View {
        List {
            // What did not go out, said once and first: one row with the latest
            // reason, opening the same sheet Walnut offers on return.
            if let latest = talk.outbox.unsent.first {
                Section {
                    Button {
                        showingUnsent = true
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: allWait ? "clock.arrow.circlepath" : "exclamationmark.bubble")
                                .foregroundStyle(allWait ? TalkTone.orange : TalkTone.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(allWait ? "Waiting to Send" : "Not Sent")
                                    .foregroundStyle(allWait ? TalkTone.orange : TalkTone.red)
                                Text(latest.reason ?? "")
                                    .font(.footnote)
                                    .foregroundStyle(Color(uiColor: .secondaryLabel))
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 4)
                            // Label colours, not the button's tint.
                            Text("\(talk.outbox.unsent.count)")
                                .foregroundStyle(Color(uiColor: .label))
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Color(uiColor: .secondaryLabel))
                        }
                    }
                    .accessibilityIdentifier("talk.unsentOpen")
                }
            }

            Section {
                Text("Press and hold the Action Button, then say anything. Walnut sends it to your CEO chat as your message when you pause, press the Action Button again, or tap Send.")
                    .accessibilityIdentifier("talk.intro")
                TalkTryRow(talk: talk, error: $tryError)
                if mic != .granted { micRow }
            }

            Section {
                TalkStepRow(number: 1, text: "Open the **Settings** app and tap **Action Button**.")
                TalkStepRow(number: 2, text: "Swipe to **Shortcut**.")
                TalkStepRow(number: 3, text: "Tap **Choose a Shortcut**, then pick **Talk to Walnut**.")
            } header: {
                Text("Set Up the Action Button")
            } footer: {
                Text("Talk to Walnut is already in your shortcuts, so there is nothing to add. iOS lets only you pick what the Action Button does. When your iPhone is locked, iOS asks for Face ID first.")
            }

            Section {
                DisclosureGroup("No Action Button?") {
                    TalkWayRow(symbol: "mic.circle", text: "Say **\u{201C}Hey Siri, talk to Walnut\u{201D}**.")
                    TalkWayRow(symbol: "switch.2", text: "**Control Center** or **Lock Screen**: add a control, pick **Shortcut**, then **Talk to Walnut**.")
                    TalkWayRow(symbol: "hand.tap", text: "**Back Tap**: in the Settings app, Accessibility, Touch, Back Tap, Double Tap, then **Talk to Walnut**.")
                    ShortcutsLink()
                        .shortcutsLinkStyle(.automaticOutline)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("talk.shortcutsLink")
                }
                .accessibilityIdentifier("talk.noActionButton")
            }
        }
        .navigationTitle("Action Button")
        .navigationBarTitleDisplayMode(.inline)
        // An opaque bar with a hard edge: scrolled text never shows through the title.
        .toolbarBackground(.visible, for: .navigationBar)
        .talkHardTopEdge()
        .sheet(isPresented: $showingUnsent) { TalkUnsentList(talk: talk) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { mic = TalkSession.systemMicAccess() }
        }
        .onChange(of: talk.phase) { _, _ in mic = TalkSession.systemMicAccess() }
    }

    @ViewBuilder
    private var micRow: some View {
        if mic == .denied {
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } label: {
                Label("Microphone is off for Walnut. Turn it on in Settings.", systemImage: "mic.slash")
            }
            .accessibilityIdentifier("talk.micOpenSettings")
        } else {
            Button {
                Task {
                    _ = await AVAudioApplication.requestRecordPermission()
                    mic = TalkSession.systemMicAccess()
                }
            } label: {
                Label("Allow the microphone", systemImage: "mic")
            }
            .accessibilityIdentifier("talk.micAllow")
        }
    }
}

/// Try it here: the same take the Action Button starts, with its state.
struct TalkTryRow: View {
    let talk: TalkSession
    @Binding var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            control
                // One height for every state, so the page below never jumps.
                .frame(maxWidth: .infinity, minHeight: 50)
            if let line = resultLine {
                Label(line.text, systemImage: line.symbol)
                    .font(.footnote)
                    .foregroundStyle(line.color)
                    .accessibilityIdentifier("talk.result")
            }
        }
        .padding(.vertical, 4)
        // The separator under this row spans the card, as the rows' text does.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    @ViewBuilder
    private var control: some View {
            switch talk.phase {
            case .listening:
                HStack {
                    Label("Listening", systemImage: "waveform")
                        .foregroundStyle(TalkTone.orange)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                    Spacer()
                    Button("Cancel") { Task { await talk.cancel(source: "settings-cancel") } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier("talk.cancel")
                    Button { Task { await talk.finishNow(source: "settings-send") } } label: {
                        Text("Send").foregroundStyle(TalkTone.onProminent)
                    }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("talk.send")
                }
            case .starting, .transcribing, .sending:
                HStack(spacing: 8) {
                    ProgressView()
                    Text(Self.busyWords(talk.phase))
                    Spacer(minLength: 0)
                }
            default:
                Button {
                    error = nil
                    Task {
                        do { try await talk.toggle(source: "settings-try") } catch { self.error = error.localizedDescription }
                    }
                } label: {
                    // Icon and words centred together; they wrap as one at large sizes.
                    HStack(spacing: 8) {
                        Image(systemName: "waveform")
                        Text("Try It Now")
                    }
                    .multilineTextAlignment(.center)
                    .foregroundStyle(TalkTone.onProminent)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .accessibilityIdentifier("talk.try")
            }
    }

    static func busyWords(_ phase: TalkSession.Phase) -> String {
        switch phase {
        case .starting: return "Opening the microphone"
        case .sending: return "Sending to your CEO"
        default: return "Getting your words"
        }
    }

    private var resultLine: (text: String, symbol: String, color: Color)? {
        if let error { return (error, "exclamationmark.triangle", TalkTone.red) }
        switch talk.phase {
        case .sent(let words): return ("Sent to your CEO: \u{201C}\(TalkSession.preview(words))\u{201D}", "checkmark.circle", TalkTone.green)
        // A kept take is said once, by the Not Sent row right below, with its reason.
        case .notSent(_, kept: true) where !talk.outbox.unsent.isEmpty:
            return nil
        case .notSent(let reason, _):
            return (reason, "exclamationmark.triangle", TalkTone.red)
        default: return nil
        }
    }
}

/// The words Talk to Walnut kept because they did not reach the CEO chat. A
/// recording with no words yet can be played back and shows its length, so the
/// person can tell which take a Resend sends to the CEO.
struct TalkUnsentRows: View {
    let talk: TalkSession
    /// The reason the list's header already says for every row, if one.
    var sharedReason: String?
    @State private var playback = TalkPlayback.shared
    @State private var confirmingDelete: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ForEach(talk.outbox.unsent) { entry in
            VStack(alignment: .leading, spacing: 6) {
                if let text = entry.text {
                    Text(text).lineLimit(3)
                    Text(Self.when(entry.createdAt))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("talk.unsent.when")
                } else {
                    recordingLine(entry)
                }
                // The reason gets the row's full width; the actions sit under it,
                // side by side on the right, each on its own line at accessibility sizes.
                status(entry)
                if typeSize.isAccessibilitySize {
                    // Stacked, the main action comes first.
                    VStack(alignment: .leading, spacing: 8) {
                        resendButton(entry, wide: true)
                        deleteButton(entry, wide: true)
                    }
                } else {
                    HStack(spacing: 16) {
                        Spacer(minLength: 0)
                        deleteButton(entry, wide: false)
                        resendButton(entry, wide: false)
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("talk.unsent.row")
            // On the row, not the list: a modifier on ForEach lands on every row.
            .confirmationDialog(
                // A recording with no words was never sent; words may have reached
                // the server before an answer was lost, so they say only what is known.
                entry.text == nil
                    ? "Delete this recording? It was never sent to your CEO chat."
                    : "Delete these words? Walnut could not confirm they reached your CEO chat.",
                isPresented: Binding(
                    get: { confirmingDelete == entry.id },
                    set: { if !$0 { confirmingDelete = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(entry.text == nil ? "Delete Recording" : "Delete Words", role: .destructive) {
                    talk.discard(entry.id)
                }
                .accessibilityIdentifier("talk.unsent.deleteConfirm")
            }
        }
        .onDisappear { playback.stop() }
    }

    /// Why it is here, and, once a Resend failed too, that it was tried again
    /// and when: the same reason would otherwise read as if nothing happened.
    @ViewBuilder
    private func status(_ entry: TalkOutbox.Entry) -> some View {
        if talk.resending.contains(entry.id) {
            Label {
                Text(entry.text == nil ? "Getting words\u{2026}" : "Sending\u{2026}")
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                ProgressView()
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("talk.unsent.resending")
        } else {
            VStack(alignment: .leading, spacing: 2) {
                if entry.reason != sharedReason {
                    Text(entry.reason ?? "")
                        .foregroundStyle(TalkSession.waits(entry) ? Color(uiColor: .secondaryLabel) : TalkTone.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if entry.attempts > 1 {
                    Text("Tried again at \(entry.updatedAt.formatted(date: .omitted, time: .shortened))")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("talk.unsent.triedAgain")
                }
            }
            .font(.footnote)
        }
    }

    private func deleteButton(_ entry: TalkOutbox.Entry, wide: Bool) -> some View {
        let busy = talk.resending.contains(entry.id)
        return Button(role: .destructive) {
            guard !busy else { return }
            playback.stop()
            confirmingDelete = entry.id
        } label: {
            Text("Delete")
                .foregroundStyle(TalkTone.red)
                .frame(maxWidth: wide ? .infinity : nil)
        }
        // Plain words: the send button stays the stronger one in the row.
        .buttonStyle(.borderless)
        .modifier(TalkBusyButton(busy: busy))
        .accessibilityIdentifier("talk.unsent.delete")
    }

    @ViewBuilder
    private func resendButton(_ entry: TalkOutbox.Entry, wide: Bool) -> some View {
        // A take that sends by itself offers a quiet Send Now; one that needs
        // the person keeps the filled Resend.
        if TalkSession.waits(entry) {
            resendCore(entry, wide: wide, title: "Send Now", onFill: false)
                .buttonStyle(.bordered)
        } else {
            resendCore(entry, wide: wide, title: "Resend", onFill: true)
                .buttonStyle(.borderedProminent)
        }
    }

    private func resendCore(_ entry: TalkOutbox.Entry, wide: Bool, title: String, onFill: Bool) -> some View {
        let busy = talk.resending.contains(entry.id)
        return Button {
            // VoiceOver can still reach a dimmed button: a second Resend is a no-op.
            guard !busy else { return }
            playback.stop()
            Task {
                let sent = await talk.resend(entry.id)
                UINotificationFeedbackGenerator().notificationOccurred(sent ? .success : .error)
            }
        } label: {
            Text(title)
                .foregroundStyle(onFill ? TalkTone.onProminent : Color.accentColor)
                .frame(maxWidth: wide ? .infinity : nil)
        }
        .modifier(TalkBusyButton(busy: busy))
        .accessibilityIdentifier("talk.unsent.resend")
    }

    @ViewBuilder
    private func recordingLine(_ entry: TalkOutbox.Entry) -> some View {
        let audio = talk.keptAudio(entry)
        let playing = playback.playingID == entry.id
        HStack(spacing: 10) {
            if let audio {
                Button {
                    playback.toggle(entry.id, url: audio.url)
                } label: {
                    Image(systemName: playing ? "stop.circle.fill" : "play.circle.fill")
                        .font(.title)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(playing ? "Stop" : "Play recording")
                .accessibilityIdentifier("talk.unsent.play")
            }
            // The time tells takes apart, so it is the title.
            VStack(alignment: .leading, spacing: 2) {
                Text(Self.when(entry.createdAt))
                    .accessibilityIdentifier("talk.unsent.when")
                Text(["Recording", audio?.seconds.map(TalkPlayback.length)].compactMap { $0 }.joined(separator: " \u{00B7} "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// "9:24 AM" today, "Nov 4, 9:24 AM" before.
    static func when(_ date: Date) -> String {
        Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

private struct TalkStepRow: View {
    let number: Int
    let text: LocalizedStringKey

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: "\(number).circle.fill").foregroundStyle(.orange)
        }
    }
}

private struct TalkWayRow: View {
    let symbol: String
    let text: LocalizedStringKey

    var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: symbol).foregroundStyle(.secondary)
        }
    }
}

/// The words and recordings that did not reach the CEO chat, as one sheet:
/// offered when Walnut comes back, and opened from Settings, Action Button.
struct TalkUnsentList: View {
    let talk: TalkSession

    /// The reason every row shares, said once in the header instead of on each.
    private var sharedReason: String? {
        let reasons = Set(talk.outbox.unsent.compactMap(\.reason))
        return reasons.count == 1 ? reasons.first : nil
    }

    private var allWait: Bool { talk.outbox.unsent.allSatisfy(TalkSession.waits) }

    /// The reason once, then when it goes out: one fixed place, so it never
    /// moves into a row as rows leave.
    private var header: String {
        let one = talk.outbox.unsent.count == 1
        let tail = allWait
            ? "Walnut tries again each time you open it."
            : (one ? "This did not reach your CEO chat." : "These did not reach your CEO chat.")
        return [sharedReason, tail].compactMap { $0 }.joined(separator: " ")
    }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        NavigationStack {
            List {
                // A Resend that went out says so here: its row leaves, as a
                // Delete's does, and the words are what reached the CEO chat.
                if let words = talk.lastResent {
                    Label("Sent to your CEO chat: \u{201C}\(TalkSession.preview(words))\u{201D}", systemImage: "checkmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(TalkTone.green)
                        .accessibilityIdentifier("talk.unsent.sent")
                }
                if !talk.outbox.unsent.isEmpty {
                    Section {
                        TalkUnsentRows(talk: talk, sharedReason: sharedReason)
                    } header: {
                        // Small at every size: the rows and their actions come first.
                        Text(header)
                            .font(.footnote)
                            .textCase(nil)
                    }
                }
            }
            .navigationTitle(allWait ? "Waiting to Send" : "Not Sent to Your CEO")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            .talkHardTopEdge()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear { talk.clearResentNotice() }
            .onChange(of: talk.outbox.unsent.isEmpty) { _, empty in
                guard empty else { return }
                // After a Resend, the "Sent" line stays long enough to read.
                if talk.lastResent == nil {
                    dismiss()
                } else {
                    Task {
                        try? await Task.sleep(for: .seconds(1.8))
                        dismiss()
                    }
                }
            }
        }
        // At accessibility text sizes half a screen holds only the header.
        .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
        // Solid: the screen behind (its tab bar, its badges) never shows through.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        .accessibilityIdentifier("talk.unsentSheet")
    }
}

/// Opens the unsent list when Walnut comes to the front with a take that did
/// not reach the CEO chat, needs the person, and was not shown yet (they
/// tapped the "Not sent" Live Activity, or just opened the app).
struct TalkUnsentSheetModifier: ViewModifier {
    @State private var talk = TalkSession.shared
    @State private var showing = false
    /// Entries already offered, kept across launches so a cold start does not
    /// offer the same words again.
    @AppStorage("walnut.talk.offeredUnsent") private var offeredRaw = ""
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            // A cold launch (the Live Activity tapped after iOS ended Walnut) has
            // no phase change to see, so the first appearance looks too.
            .task {
                offerIfNew()
                // No network work in a prewarm launch: only once the app is in front.
                LaunchGate.shared.whenActive {
                    TalkNetworkWatch.shared.start()
                    Task { await TalkSession.shared.resendKept(source: "app-active") }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                // Offered at once; what can go out now goes while the sheet shows,
                // its rows saying so, and leaves the list by itself.
                offerIfNew()
                Task { await talk.resendKept(source: "app-active") }
            }
            .sheet(isPresented: $showing, onDismiss: markOffered) { TalkUnsentList(talk: talk) }
    }
}

private extension TalkUnsentSheetModifier {
    var offered: Set<String> { Set(offeredRaw.split(separator: ",").map(String.init)) }

    /// Only takes that need the person interrupt: one Walnut sends by itself
    /// waits quietly in Settings, Action Button.
    func offerIfNew() {
        let fresh = talk.outbox.unsent.filter { !TalkSession.waits($0) }.map(\.id).filter { !offered.contains($0) }
        if !fresh.isEmpty, !talk.isBusy { showing = true }
    }

    /// Only ids still on the list are remembered, so the mark stays small.
    func markOffered() {
        offeredRaw = talk.outbox.unsent.map(\.id).joined(separator: ",")
    }
}

extension View {
    func talkUnsentSheet() -> some View { modifier(TalkUnsentSheetModifier()) }
}

/// Talk to Walnut's status colours, dark enough on white and light enough on
/// black for small text (4.5:1 or better), unlike the system orange and green.
enum TalkTone {
    static let red = adaptive(light: (0.68, 0.07, 0.07), dark: (1.0, 0.56, 0.53))
    static let green = adaptive(light: (0.10, 0.48, 0.20), dark: (0.40, 0.86, 0.50))
    static let orange = adaptive(light: (0.70, 0.31, 0.0), dark: (1.0, 0.64, 0.30))
    /// Text on a prominent (accent-filled) button: white on the dark light-mode
    /// accent, black on the light dark-mode one.
    static let onProminent = Color(uiColor: .systemBackground)

    private static func adaptive(light: (CGFloat, CGFloat, CGFloat), dark: (CGFloat, CGFloat, CGFloat)) -> Color {
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        })
    }
}

/// A row button while its take is being resent: drawn as it was, dimmed, and
/// not tappable. `.disabled` would blank a prominent button's fill under text
/// forced to the background colour, so the button seemed to vanish.
private struct TalkBusyButton: ViewModifier {
    let busy: Bool

    func body(content: Content) -> some View {
        content
            .opacity(busy ? 0.45 : 1)
            .allowsHitTesting(!busy)
    }
}

private extension View {
    /// iOS 26 fades scrolled content softly under the bar, which leaves words
    /// readable behind the title; a hard edge cuts them off there. A helper
    /// rather than an inline `if #available`, because the modifier changes the type.
    @ViewBuilder
    func talkHardTopEdge() -> some View {
        if #available(iOS 26.0, *) {
            self.scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }
}
