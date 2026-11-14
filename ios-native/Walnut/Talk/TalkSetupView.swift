import AppIntents
import AVFoundation
import SwiftUI
import UIKit

/// Settings, Action Button: what Talk to Walnut and Dictate do, a way
/// to try each here, the exact steps to put one on the Action Button (only the
/// person can, in iOS Settings), other places they run, and anything not delivered.
struct TalkSetupView: View {
    @State private var talk = TalkSession.shared
    @State private var mic = TalkSession.systemMicAccess()
    @State private var tryError: String?
    @State private var dictateError: String?
    @State private var showingUnsent = false
    @Environment(\.scenePhase) private var scenePhase

    private var allWait: Bool { talk.outbox.unsent.allSatisfy(TalkSession.waits) }
    private var allCopy: Bool { talk.outbox.unsent.allSatisfy { $0.copy == true } }
    /// Only dictations kept by the person's choice: no warning colour, nothing failed.
    private var allChosen: Bool { talk.outbox.unsent.allSatisfy(TalkSession.awaitsChoice) }
    private var rowTone: Color { allWait ? TalkTone.orange : allChosen ? Color(uiColor: .label) : TalkTone.red }

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
                            Image(systemName: allWait ? "clock.arrow.circlepath" : allChosen ? "text.bubble" : "exclamationmark.bubble")
                                .foregroundStyle(allChosen ? Color.accentColor : rowTone)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(allWait ? "Waiting to Send" : allCopy ? "Dictations" : "Not Sent")
                                    .foregroundStyle(rowTone)
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
                Text("Press and hold the Action Button: Walnut listens without opening. Say anything, then tap Send on the Lock Screen or in the Dynamic Island, or press the Action Button again: it goes to your CEO chat as your message.")
                    .accessibilityIdentifier("talk.intro")
                TalkTryRow(talk: talk, error: $tryError)
                if mic != .granted { micRow }
            }

            Section {
                Text("Dictate opens Walnut and listens the same way, then shows your words on one page: send them to your CEO, or copy them to paste into any app. Nothing goes anywhere until you pick.")
                    .accessibilityIdentifier("talk.dictate.intro")
                TalkTryRow(talk: talk, error: $dictateError, destination: .dictation)
            } header: {
                Text("Dictate")
            }

            Section {
                TalkStepRow(number: 1, text: "Open the **Settings** app and tap **Action Button**.")
                TalkStepRow(number: 2, text: "Swipe to **Shortcut**.")
                TalkStepRow(number: 3, text: "Tap **Choose a Shortcut**, then pick **Talk to Walnut**, or **Dictate** to see your words first, then send or copy them.")
            } header: {
                Text("Set Up the Action Button")
            } footer: {
                Text("Both are already in your shortcuts, so there is nothing to add. iOS lets only you pick what the Action Button does. When your iPhone is locked, iOS asks for Face ID first.")
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

/// Try it here: the same take the Action Button starts, with its state. One row per
/// destination; a take shows on the row of the destination it was started for.
struct TalkTryRow: View {
    let talk: TalkSession
    @Binding var error: String?
    var destination: TalkDestination = .ceo

    private var copy: Bool { destination == .dictation }
    /// The take on screen (or the last one) is this row's.
    private var mine: Bool { talk.destination == destination }
    /// Identifiers: the CEO row keeps its own, the clipboard row's carry "dictate".
    private func id(_ name: String) -> String { copy ? "talk.dictate.\(name)" : "talk.\(name)" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            control
                // One height for every state, so the page below never jumps.
                .frame(maxWidth: .infinity, minHeight: 50)
            if let line = resultLine {
                Label(line.text, systemImage: line.symbol)
                    .font(.footnote)
                    .foregroundStyle(line.color)
                    // One element that reads the words: the symbol on its own read "Paste".
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(line.text)
                    .accessibilityIdentifier(id("result"))
            }
        }
        .padding(.vertical, 4)
        // The separator under this row spans the card, as the rows' text does.
        .alignmentGuide(.listRowSeparatorLeading) { _ in 0 }
    }

    @ViewBuilder
    private var control: some View {
            switch mine ? talk.phase : .idle {
            case .listening:
                HStack {
                    Label("Listening", systemImage: "waveform")
                        .foregroundStyle(TalkTone.orange)
                        .symbolEffect(.variableColor.iterative, options: .repeating)
                    Spacer()
                    Button("Cancel") { Task { await talk.cancel(source: "settings-cancel") } }
                        .buttonStyle(.bordered)
                        .accessibilityIdentifier(id("cancel"))
                    Button { Task { await talk.finishNow(source: "settings-send") } } label: {
                        Text(copy ? "Done" : "Send").foregroundStyle(TalkTone.onProminent)
                    }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier(id(copy ? "done" : "send"))
                }
            case .starting, .transcribing, .sending:
                HStack(spacing: 8) {
                    ProgressView()
                    Text(Self.busyWords(talk.phase))
                        .accessibilityIdentifier(id("busy"))
                    Spacer(minLength: 0)
                }
            default:
                Button {
                    error = nil
                    Task {
                        do {
                            try await talk.toggle(source: copy ? "settings-try-dictate" : "settings-try", to: destination)
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                } label: {
                    // Icon and words centred together; they wrap as one at large sizes.
                    HStack(spacing: 8) {
                        Image(systemName: copy ? "text.bubble" : "waveform")
                        Text(copy ? "Try Dictation" : "Try It Now")
                    }
                    .multilineTextAlignment(.center)
                    .foregroundStyle(TalkTone.onProminent)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                // The other row's take is on screen: one take at a time.
                .disabled(!mine && talk.isBusy)
                .accessibilityIdentifier(id("try"))
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
        guard mine else { return nil }
        switch talk.phase {
        case .sent(let words): return ("Sent to your CEO: \u{201C}\(TalkSession.preview(words))\u{201D}", "checkmark.circle", TalkTone.green)
        case .copied(let words): return ("Copied: \u{201C}\(TalkSession.preview(words))\u{201D}", "doc.on.doc", TalkTone.green)
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
    /// The row whose words a Copy just took, so its button says so.
    @State private var copiedWords: String?
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
                        copyWordsButton(entry, wide: true)
                        deleteButton(entry, wide: true)
                    }
                } else {
                    HStack(spacing: 16) {
                        Spacer(minLength: 0)
                        deleteButton(entry, wide: false)
                        copyWordsButton(entry, wide: false)
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
                entry.copy == true
                    ? (entry.text == nil ? "Delete this recording? It was never sent or copied." : "Delete these words? They were never sent or copied.")
                    : entry.text == nil
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
                Text(entry.text == nil ? "Getting words\u{2026}" : entry.copy == true ? "Copying\u{2026}" : "Sending\u{2026}")
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
                        .foregroundStyle(TalkSession.waits(entry) || TalkSession.awaitsChoice(entry)
                            ? Color(uiColor: .secondaryLabel) : TalkTone.red)
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
        // A dictation waits for the person's Send or Copy: both, as on its page.
        if entry.copy == true {
            if wide {
                resendCore(entry, wide: true, title: "Send to CEO", onFill: true, send: true)
                    .buttonStyle(.borderedProminent)
                resendCore(entry, wide: true, title: "Copy", onFill: false)
                    .buttonStyle(.bordered)
            } else {
                resendCore(entry, wide: false, title: "Copy", onFill: false)
                    .buttonStyle(.bordered)
                resendCore(entry, wide: false, title: "Send to CEO", onFill: true, send: true)
                    .buttonStyle(.borderedProminent)
            }
        } else if TalkSession.waits(entry) {
            resendCore(entry, wide: wide, title: "Send Now", onFill: false)
                .buttonStyle(.bordered)
        } else {
            resendCore(entry, wide: wide, title: "Resend", onFill: true)
                .buttonStyle(.borderedProminent)
        }
    }

    /// Copy beside Send for words on their way to the CEO: copied, they still go.
    @ViewBuilder
    private func copyWordsButton(_ entry: TalkOutbox.Entry, wide: Bool) -> some View {
        if entry.copy != true, entry.text != nil {
            Button {
                let done = talk.copyWords(entry.id)
                copiedWords = done ? entry.id : nil
                UINotificationFeedbackGenerator().notificationOccurred(done ? .success : .error)
            } label: {
                Text(copiedWords == entry.id ? "Copied" : "Copy")
                    .foregroundStyle(Color.accentColor)
                    .frame(maxWidth: wide ? .infinity : nil)
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("talk.unsent.copyWords")
        }
    }

    private func resendCore(_ entry: TalkOutbox.Entry, wide: Bool, title: String, onFill: Bool, send: Bool = false) -> some View {
        let busy = talk.resending.contains(entry.id)
        return Button {
            // VoiceOver can still reach a dimmed button: a second Resend is a no-op.
            guard !busy else { return }
            playback.stop()
            Task {
                let sent = await talk.resend(entry.id, send: send)
                UINotificationFeedbackGenerator().notificationOccurred(sent ? .success : .error)
            }
        } label: {
            Text(title)
                .foregroundStyle(onFill ? TalkTone.onProminent : Color.accentColor)
                .frame(maxWidth: wide ? .infinity : nil)
        }
        .modifier(TalkBusyButton(busy: busy))
        // A dictation's Copy keeps the row's one Resend id; its Send has its own.
        .accessibilityIdentifier(send ? "talk.unsent.send" : "talk.unsent.resend")
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
    private var allCopy: Bool { talk.outbox.unsent.allSatisfy { $0.copy == true } }

    /// The reason once, then when it goes out: one fixed place, so it never
    /// moves into a row as rows leave.
    private var header: String {
        let one = talk.outbox.unsent.count == 1
        let tail = allWait
            ? "Walnut tries again each time you open it."
            : allCopy
            ? (one ? "Send it to your CEO, or copy it." : "Send each to your CEO, or copy it.")
            : (one ? "This did not reach your CEO chat." : "These did not reach your CEO chat.")
        return [sharedReason, tail].compactMap { $0 }.joined(separator: " ")
    }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var shownTitle: String?

    /// From the rows not going out right now: a dictation sent from this list is a take
    /// for the CEO while it goes, and must not retitle the list "Not Sent" on its way out.
    private var listTitle: String? {
        let rows = talk.outbox.unsent.filter { !talk.resending.contains($0.id) }
        guard !rows.isEmpty else { return nil }
        if rows.allSatisfy(TalkSession.waits) { return "Waiting to Send" }
        return rows.allSatisfy { $0.copy == true } ? "Dictations" : "Not Sent to Your CEO"
    }

    var body: some View {
        NavigationStack {
            List {
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
            // The last rows sent or copied leave the list empty: it keeps the title it had,
            // never one that says something still waits.
            // A Resend that went out says so over the list, a moment, then gone: a line in
            // the list moved every row under the thumb when it went.
            .overlay(alignment: .bottom) {
                if let words = talk.lastResent {
                    Label(
                        talk.lastResentCopied
                            ? "Copied: \u{201C}\(TalkSession.preview(words))\u{201D}"
                            : "Sent to your CEO chat: \u{201C}\(TalkSession.preview(words))\u{201D}",
                        systemImage: talk.lastResentCopied ? "doc.on.doc.fill" : "checkmark.circle.fill"
                    )
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(TalkTone.green)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Capsule().fill(Color(uiColor: .secondarySystemGroupedBackground)).shadow(radius: 6, y: 2))
                    .padding(.horizontal, 20)
                    .padding(.bottom, 12)
                    .accessibilityIdentifier("talk.unsent.sent")
                    .task(id: words) {
                        try? await Task.sleep(for: .seconds(6))
                        if talk.lastResent == words { talk.clearResentNotice() }
                    }
                }
            }
            .navigationTitle(listTitle ?? shownTitle ?? "Action Button")
            .onChange(of: listTitle, initial: true) { _, title in if let title { shownTitle = title } }
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
    @AppStorage("walnut.talk.offeredUnsent", store: AppPrefs.defaults) private var offeredRaw = ""
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            // A cold launch (the Live Activity tapped after iOS ended Walnut) has
            // no phase change to see, so the first appearance looks too.
            .task {
                offerIfNew()
                // No network work in a prewarm launch: only once the app is in front.
                LaunchGate.shared.whenActive {
                    // A page the last process left open opens again (`reopenUnseenPage`).
                    if TalkSession.shared.isReviewing { TalkPanel.shared.show() }
                    TalkNetworkWatch.shared.start()
                    Task { await TalkSession.shared.resendKept(source: "app-active") }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                // A take listening from behind (the person tapped its Live Activity, or
                // opened Walnut): the Talk screen shows it, the whole screen its Send.
                if talk.phase == .listening { TalkPanel.shared.show() }
                // A dictation's words wait on their page (they came while Walnut was away),
                // and one the person never saw opens on it too.
                // Not while a press brings Walnut forward for its own take.
                if !talkPressOpening { talk.reopenUnseenPageIfIdle() }
                if talk.isReviewing { TalkPanel.shared.show() }
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
        // The page's own words are on the page, not news; and nothing pops under a page or a take.
        // A dictation kept by choice is never news here: an unseen one opens on its page.
        let fresh = talk.outbox.unsent.filter { !TalkSession.waits($0) && !TalkSession.awaitsChoice($0) }.map(\.id)
            .filter { !offered.contains($0) && $0 != talk.reviewTake && !talk.closedPages.contains($0) }
        if !fresh.isEmpty, !talk.isBusy, !talk.isReviewing, !TalkPanel.shared.isShown { showing = true }
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
