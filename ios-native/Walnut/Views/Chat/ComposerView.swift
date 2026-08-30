import SwiftUI
import PhotosUI

/// Reusable chat input bar — rounded field + photo/mic/send button. The draft
/// text and image selection live in `ComposerDrafts` (app-scoped, keyed by
/// `draftKey`), NOT in view `@State`; the parent does the actual send via
/// `onSend`.
///
/// Invariants (freeze-proof by design):
///  - The TextField is NEVER disabled. `busy` and `disabled` only gate the
///    SEND action — the user can always type, select, and copy their text.
///  - The draft AND the image selection are cleared on send; failure
///    preservation is the STORE's job (failed bubbles keep their text AND
///    images in the timeline with tap-to-retry), so a slow network error can
///    never clobber or lose composed text or attachments.
///  - Draft ownership is OUTSIDE the view. View-local `@State` is only as
///    durable as the view's identity, and this view sits in a
///    `safeAreaInset` whose geometry the keyboard changes — an identity churn
///    there used to wipe typed text (A4: type, dismiss keyboard, draft gone).
///
/// Voice input: mic button (shown when there's nothing to send) records m4a and
/// sends it to the server for transcription; the recognized text lands in
/// the draft for review before sending. A live recording is view-scoped: it
/// stops on disappear so navigating away can never leave an invisible mic open.
///
/// Voice Quick Action: when `acceptsVoiceQuickAction` is set, this composer also
/// serves the Home-screen "Voice to Walnut" shortcut — it opens the mic on
/// arrival and, on stop, sends the transcript STRAIGHT through `onSend` instead
/// of parking it in the draft. Only the chat composer opts in; a session
/// composer must never swallow the shortcut.
///
/// Image input: photo button opens the native PhotosPicker (iOS 16+, sandboxed
/// — no photo-library permission prompt). Picked images are downscaled + JPEG
/// encoded on-device and shown as a removable thumbnail strip above the field.
///
/// Layout (two rows, matching the reference composer the user asked us to copy):
/// the FIELD owns a full-width row of its own, and every control sits on a BOTTOM
/// row below it, left to right `+`, model pill, then mic and send pushed right.
/// The previous shape put `+`/field/mic/send in ONE row with the model pill
/// stranded on a row above; that had two measured problems the two-row shape
/// dissolves rather than mitigates:
///  - A fifth control in the text row squeezes the field on a 390pt phone, and a
///    variable-width model label ("Opus 5 · Extra High") resized the field on
///    every model switch. With the field on its own row, nothing competes with it
///    for width, so the label can be as long as it likes.
///  - The old model row was CONDITIONAL (no model ⇒ no row), so the composer's
///    height changed the moment an async model lookup resolved. The composer
///    lives in a `safeAreaInset` over the transcript, and a height change there
///    moves the scroll view's visible rect: exactly the class of geometry churn
///    the freeze work spent three rounds bounding. The bottom row is now
///    UNCONDITIONAL (it owns mic and send), and the pill is a ≤32pt chip inside a
///    row whose height the 32pt buttons already fix, so a model resolving changes
///    the composer's width usage and never its height.
/// The cost of the shape is one extra row of vertical space at all times. That is
/// the trade the reference makes, and the one the user picked.
struct ComposerBar: View {
    let placeholder: String
    var busy: Bool = false
    var disabled: Bool = false
    var disabledNotice: String? = nil
    /// Identity of the thread this composer writes into ("chat:<conversation>",
    /// "session:<id>"). Scopes the durable draft.
    ///
    /// NOT a stable identity for "which screen am I on": the chat key follows
    /// `ChatStore.activeID`, which starts nil and is filled by hydration, so the SAME
    /// mounted composer reports under a new key mid-life with no appear/disappear pair
    /// around it. That is why the dock is told the SURFACE separately, and why a key
    /// change retracts the key it leaves behind (see the publishers on the body).
    var draftKey: String = "chat"
    /// WHICH SCREEN this composer is on, for the file-preview dock's clearance. Left
    /// `.unattached` a composer answers for whatever surface is in front, which is the
    /// safe direction but not the true one — every composer the dock bar can be seen
    /// over declares its surface. See `ComposerSurfaceID`.
    var surface: ComposerSurfaceID = .unattached
    /// Opt in to serving the Home-screen voice Quick Action (chat composer only).
    var acceptsVoiceQuickAction: Bool = false
    /// Run right before a quick-action take opens the mic — the chat composer
    /// uses it to make sure the MAIN agent is selected, so the transcript can
    /// never land on whichever subagent the user last browsed.
    var prepareVoiceQuickAction: (() -> Void)? = nil
    /// Where the switchable model lives for this composer (a session, or a chat
    /// conversation's lane session). Absent = no model pill.
    var modelSource: ComposerControlsModel.Source? = nil
    /// The model string already known from the row, shown while the catalog loads
    /// and kept as the label if it never arrives.
    var fallbackModel: String? = nil
    /// Read-only "where is this served from" for the `+` menu. Absent = the row
    /// is omitted (nothing honest to say).
    var hostProvenance: ComposerHostProvenance? = nil
    let onSend: (String, [SelectedImage]) async -> Bool

    /// Optional so roots that never inject a dock still build (RootView's DEBUG
    /// harness entry points bypass the store wiring), and so a composer inside a
    /// sheet is not required to have one.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    /// Drives the published-height channel's two lifecycle rules: a retraction is
    /// only honest while the app is active, and returning from the background
    /// re-asserts the measurement (see the three publishers on the body).
    @Environment(\.scenePhase) private var scenePhase

    /// Last height this composer measured, so returning to a retained tab or coming
    /// back from the background can re-publish it (see the publishers on the body).
    @State private var measuredHeight: CGFloat = 0

    @State private var voice = VoiceRecorder()
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var imageNotice: String?
    @State private var quickAction = VoiceQuickAction.shared
    /// True between onAppear and onDisappear. A quick action may only open the
    /// mic on a composer the user can actually SEE: a TabView retains the
    /// non-selected tabs' views, so `onChange` alone would happily start an
    /// invisible recording — the exact "hot mic with no way to stop it" failure
    /// the onDisappear guard below exists to prevent.
    @State private var onScreen = false
    @FocusState private var focused: Bool
    /// Focus for the long-draft editor. A `UIViewRepresentable` cannot ride
    /// `@FocusState` dependably, so its focus is a plain two-way `@State` the
    /// representable syncs with its first-responder status.
    @State private var longDraftFocused = false
    @State private var drafts = ComposerDrafts.shared
    /// Model + effort for the pill. Owned here (not by the parent) so it survives
    /// the parent's body passes; `attach` is idempotent per source.
    @State private var controls = ComposerControlsModel()
    /// Photo picker presentation is now explicit: the `+` is a MENU (photos +
    /// host provenance), so the picker is presented rather than being the button.
    @State private var showPhotoPicker = false

    private static let maxImages = 5

    /// Bindings onto the app-scoped draft store — the TextField edits that
    /// directly, so nothing depends on this view's identity surviving.
    private var draft: Binding<String> {
        Binding(
            get: { drafts.draft(draftKey) },
            set: {
                drafts.setDraft($0, key: draftKey)
                // Freeze-report context. Runs per keystroke, so it must stay
                // O(1): utf8.count is a stored length on native Swift strings
                // (String.count walks graphemes — do NOT use it here), and the
                // push itself is one Int write under a lock.
                FreezeContext.shared.setDraftChars($0.utf8.count)
            }
        )
    }

    private var selectedImages: [SelectedImage] { drafts.images(draftKey) }

    private var trimmed: String { draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasContent: Bool { !trimmed.isEmpty || !selectedImages.isEmpty }
    private var canSend: Bool { !busy && !disabled && hasContent }

    var body: some View {
        VStack(spacing: 0) {
            if disabled, let notice = disabledNotice {
                noticeRow(notice, icon: "exclamationmark.circle")
            }
            if let voiceError = voice.errorMessage {
                noticeRow(voiceError, icon: "mic.slash") {
                    voice.errorMessage = nil
                }
            }
            if let imageNotice {
                noticeRow(imageNotice, icon: "photo.badge.exclamationmark") {
                    self.imageNotice = nil
                }
            }
            // Preserved voice takes (failed upload / interruption / crash /
            // view dismissal) — non-modal retry affordance. Audio is never
            // deleted until it transcribes or the user explicitly discards.
            if voice.state == .idle, voice.pendingCount > 0 {
                pendingVoiceRow
            }
            if voice.state == .recording {
                recordingRow
            } else {
                if !selectedImages.isEmpty { thumbnailStrip }
                fieldRow
                bottomControlRow
            }
        }
        .background(.bar)
        // Publish the composer's WHOLE height (notices + voice-retry row +
        // thumbnail strip + field + control row) so the file-preview dock bar can
        // seat itself above all of it.
        //
        // This channel exists because the dock used to guess with
        // `tabBar + 32 + 6 + 8 + gap`, and the guess only counted the control row:
        // measured, `file.dock.bar` [12,694][390,739] fully CONTAINED
        // `chat.composer` [28,714][374,736], i.e. the seat sat ON the text field
        // (P2, 2026-08-29). No constant can be right here — the field grows to six
        // lines and every row above it is conditional — so the composer reports and
        // the dock reads.
        //
        // `onGeometryChange` (iOS 18) rather than a `GeometryReader` background
        // writing `@State`: the value is delivered AFTER the layout pass has finished
        // instead of during it.
        //
        // THE STORE FIELD IT WRITES *IS* OBSERVED, and the earlier version of this
        // comment claimed the opposite ("`@ObservationIgnored`… nothing in the view
        // graph observes it"). Both halves were false by the time it was written: the
        // first cut really did mark it `@ObservationIgnored`, by analogy with the P0-2
        // freeze rule, and the dock bar then never re-rendered when the height
        // changed, so the seat stayed frozen where the chat composer used to be on
        // every tab (measured [12,626][390,670] on all three). Making it observed is
        // the fix, and the reason it is SAFE is not "nobody observes it" but that the
        // P0-2 hazard is a CYCLE, and there is no edge back here:
        //  - writer: this composer, inside a tab.
        //  - reader: `FilePreviewDockOverlay`, an overlay on the `TabView`. A DISJOINT
        //    subtree, and the bar's own layout cannot change this composer's height,
        //    so a publish can never re-invalidate the thing being measured.
        //  - cost is bounded anyway: the store quantises to whole points and drops an
        //    unchanged value, and the reader is a leaf whose body is one capsule.
        //
        // A REPORT IS NOT A CLAIM OF EXCLUSIVITY, and that distinction is the P1's
        // real root cause (instrumented 2026-08-29; the trail is in
        // `ComposerPresence`). A `TabView` keeps the tabs it is not showing mounted,
        // so the Chat tab's composer is alive while the user is on a session page, and
        // SwiftUI re-runs its `onAppear`/`onDisappear` around every scene-phase
        // transition. When the store held ONE composer slot, that invisible composer's
        // goodbye erased the VISIBLE composer's presence and the bar dropped onto the
        // control row. Nothing in this view can tell "my tab is in front" apart from
        // "my view is mounted", so the store keeps presence per composer instead of
        // asking these publishers to be more honest than SwiftUI lets them be.
        //
        // FOUR publishers, and all four are needed, each covering a hole the others
        // leave:
        //  1. this geometry sink: EDGE-triggered. A `TabView` retains the tabs it is
        //     not showing, so a composer the user comes back to is still mounted at an
        //     unchanged height and this closure never fires again. Measured with only
        //     this half: after a trip to Notes and back the chat composer had reported
        //     nothing, so the seat sat at [12,746][390,791] straight across
        //     `chat.composer` [28,714][374,736].
        //  2. `onAppear`: the level-triggered re-assert for that trip.
        //  3. `onChange(of: scenePhase)`: the same re-assert for a BACKGROUND/return,
        //     which `onAppear` does NOT cover (measured 3/3 on a session conversation
        //     page, the P1 in `ComposerClearance`).
        //  4. `onChange(of: draftKey)`: the HAND-OFF, and the second P1's root cause
        //     (2026-08-30). This composer's key is not stable — `ChatStore.activeID`
        //     starts nil, hydration fills it, `switchAgent` clears it again — and a key
        //     change re-identifies nothing, so SwiftUI runs neither `onDisappear` (which
        //     is the only thing that ever retracts) nor `onAppear`. The old key stayed
        //     registered for the life of the process, presence could never empty, and
        //     every composer-less tab inherited its height: `file.dock.bar` measured
        //     [12,575][390,620] IDENTICALLY on Settings, Notes, Inbox and Tasks. So a
        //     key change says goodbye for the key it leaves behind.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.height
        } action: { height in
            // Only real measurements are remembered. Backgrounding lays the hierarchy
            // out at zero height for the snapshot, and keeping that would leave the
            // foreground re-assert below with nothing to re-assert.
            if height > 0 { measuredHeight = height }
            dock?.reportComposer(key: draftKey, surface: surface, height: height)
        }
        // The level-triggered half: coming back on screen re-asserts whatever was
        // last measured. The store drops an unchanged value, so this is free when
        // the composer never left.
        .onAppear {
            if measuredHeight > 0 {
                dock?.reportComposer(key: draftKey, surface: surface, height: measuredHeight)
            }
        }
        // The hand-off. Retract the key this composer just stopped being, then re-assert
        // under the new one in the same breath so the surface is never momentarily
        // composer-less (which would hide the seat for a frame).
        .onChange(of: draftKey) { previous, current in
            dock?.reportComposer(key: previous, surface: surface, height: nil)
            if measuredHeight > 0 {
                dock?.reportComposer(key: current, surface: surface, height: measuredHeight)
            }
        }
        // The MISSING recovery leg (P1, 2026-08-29). Backgrounding the app on a
        // session conversation page and returning left the published height unknown
        // with the composer still on screen, and the bar then painted straight across
        // `chat.plus`/pill/`chat.mic`/`chat.send`, and a tap meant for SEND hit
        // `file.dock.close`, throwing the docked report away without sending the
        // draft. `onAppear` does not fire on the way back (the view was never
        // removed), and `onGeometryChange` does not either (the height is unchanged),
        // so the only honest trigger is the scene phase.
        //
        // Who may re-assert: the composer the user can SEE (`onScreen`), or one whose
        // SURFACE is the one on screen. The old form of this guard asked whether this
        // composer still owned the store's single channel (`composerKey == draftKey`),
        // which stopped meaning anything once presence became a set — with several keys
        // registered, "newest" is whichever invisible tab reported last. Surface
        // identity answers the question the guard was actually asking, and a report
        // that lands on a surface nobody is looking at can no longer move the seat at
        // all (see `ComposerSurfaceID`).
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, measuredHeight > 0 else { return }
            guard onScreen || dock?.isActiveComposerSurface(surface) == true else { return }
            dock?.reportComposer(key: draftKey, surface: surface, height: measuredHeight)
        }
        // The `+` menu presents the picker instead of BEING it, so photos keep
        // working while the menu also hosts the host-provenance row.
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickerItems,
            maxSelectionCount: Self.maxImages,
            matching: .images,
            photoLibrary: .shared()
        )
        .onAppear {
            onScreen = true
            if let modelSource {
                controls.attach(modelSource, fallbackModel: fallbackModel)
            }
            // An interruption (call / Siri) auto-transcribes the partial take.
            // For a quick-action take that text is still owed to the agent —
            // route it the same way a normal stop would.
            voice.onAutoStopText = { text in deliver(text) }
            // Crash/relaunch recovery: takes preserved by an earlier run (or
            // by another composer instance) surface here as the retry row.
            voice.refreshPending()
            consumeVoiceQuickActionIfPending()
        }
        // Warm launch: the shortcut arrives while this view is already mounted,
        // so onAppear never runs again — the mailbox change is the trigger.
        .onChange(of: quickAction.pending) { _, request in
            if request != nil { consumeVoiceQuickActionIfPending() }
        }
        .onDisappear {
            onScreen = false
            // Retract the published height, KEYED, so leaving a session page cannot
            // erase the height of the composer that is now on screen (SwiftUI runs
            // the incoming view's appear before the outgoing view's disappear).
            //
            // Only while the app is ACTIVE. A backgrounding fires this for composers
            // that are still on screen and never fires the matching `onAppear` on the
            // way back, and a retraction believed then is indistinguishable from "he
            // switched to Settings": the bar dropped to tab-bar-only clearance and
            // painted over the composer (the P1 in `ComposerClearance`). The store
            // holds the same line from the other side (`retractComposer` ignores a
            // retraction once `.background` has been seen) because the two triggers
            // fire at different moments: this guard covers the `.inactive` window
            // before the store is told anything.
            //
            // Neither guard was sufficient, and the reason is worth keeping: the
            // retraction that actually broke the bar arrived while the app really WAS
            // active, from a composer that really HAD disappeared — the retained Chat
            // tab's. A guard on the app's phase cannot see that, so the fix lives in
            // the store's shape (`ComposerPresence`), and this retraction is now
            // scoped to this composer's own entry.
            if scenePhase == .active {
                dock?.reportComposer(key: draftKey, height: nil)
            }
            // The recorder is registered app-wide with LifecycleHub but its UI
            // lives in THIS view. Navigating away mid-recording (tab switch,
            // pop, sheet dismiss) hid the recording row while the mic stayed
            // hot — an invisible live recording burning battery and privacy
            // indicator with no way to stop it. View gone = mic off, but the
            // audio is PRESERVED (never silently deleted — the field incident)
            // and resurfaces as the retry row when the composer returns.
            if voice.state == .recording {
                voice.preserveAndStop(reason: "view-dismissed")
                // The take was preserved, NOT transcribed — a later Retry must
                // land in the draft for review, not auto-send text the user
                // never saw. (The audio itself is untouched, as always.)
                quickAction.clear(reason: "view-dismissed")
            }
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await loadPicked(items) }
        }
        // Focus edges are a freeze-report breadcrumb: the build-35 field freeze
        // fired ~5s after a transcription focused the keyboard, and focus churn
        // is what drives keyboard show/hide.
        .onChange(of: focused) { _, isFocused in
            FreezeContext.shared.note(isFocused ? "focus" : "blur")
        }
        .onChange(of: longDraftFocused) { _, isFocused in
            FreezeContext.shared.note(isFocused ? "focus" : "blur")
        }
        // Crossing the long-draft threshold swaps the field, which drops focus
        // with it. Hand focus over so a paste or a dictation that trips the swap
        // doesn't dismiss the keyboard mid-compose.
        .onChange(of: useLongDraftEditor) { _, isLong in
            if isLong, focused { focused = false; longDraftFocused = true }
            if !isLong, longDraftFocused { longDraftFocused = false; focused = true }
        }
    }

    // MARK: - Rows

    /// Above this many UTF-8 bytes the field switches to `LongDraftEditor`.
    ///
    /// Chosen from the measured curve on the real hosted composer (see
    /// `ComposerFreezeTests` / `LongDraftEditor`'s header): one relayout costs
    /// 1.65ms at 148 chars but 62.7ms at 5,000 and 2,353ms at 50,000 — and a
    /// relayout happens per keystroke, per focus edge, and per keyboard-geometry
    /// change. 2,000 sits above every ordinary typed message (so the everyday
    /// path is the untouched SwiftUI TextField) and below the region where a
    /// single relayout stops fitting a frame.
    ///
    /// UTF-8 bytes, not characters: `String.count` walks grapheme clusters (O(n))
    /// and this is evaluated on every body pass. NOTE the unit conversion this
    /// implies — the measured curve above is char-indexed while this gate is
    /// byte-indexed, and CJK runs ~3 bytes/char, so CJK drafts switch at ~667
    /// characters (ASCII at 2,000). That earlier switchover for CJK is
    /// DELIBERATE, not a slip: CJK glyph runs do more TextKit work per
    /// character, the bounded editor is visually near-identical (sim-verified
    /// with a 1,500-char CJK draft), and long dictation bursts — the field
    /// ignition scenario — are exactly the drafts we want off the O(n) path.
    static let longDraftThreshold = 2_000

    private var useLongDraftEditor: Bool {
        draft.wrappedValue.utf8.count > Self.longDraftThreshold
    }

    /// Does the bottom row carry a model pill?
    ///
    /// A static pure function so a test can drive the REAL rule without a store,
    /// a network, or a hosted view. Two conditions, and they are different
    /// questions: `modelSource` is whether this composer has anywhere for a model
    /// to LIVE (a new-session draft has no session yet, so it passes nil), and
    /// `pillLabel` is whether the lookup has produced something true to SAY. Both
    /// must hold; an empty label counts as nothing, because a blank capsule is a
    /// control that answers no question.
    ///
    /// This used to gate the whole row, which meant an async model lookup
    /// resolving CHANGED THE COMPOSER'S HEIGHT under a `safeAreaInset` (see the
    /// type comment). It now gates only the chip, so the row's height is fixed by
    /// its 32pt buttons whatever the model does.
    static func showsModelPill(modelSource: ComposerControlsModel.Source?, pillLabel: String?) -> Bool {
        guard modelSource != nil else { return false }
        guard let pillLabel, !pillLabel.isEmpty else { return false }
        return true
    }

    private var showsModelPill: Bool {
        Self.showsModelPill(modelSource: modelSource, pillLabel: controls.pillLabel)
    }

    /// The text field, alone on a full-width row.
    ///
    /// Nothing shares this row, which is the whole point of the two-row shape: the
    /// field's width is now independent of how long the model's name is and of how
    /// many buttons the composer carries.
    private var fieldRow: some View {
        // Long drafts (a big paste, or several dictations appended together) move
        // to a viewport-bounded UITextView. The plain TextField must lay the WHOLE
        // string out to apply `lineLimit(1...6)`, so its cost grows with the draft
        // and there is no cap on the draft; the editor's cost is constant. Text is
        // never truncated either way: only the MEASUREMENT is bounded.
        //
        // Both branches get IDENTICAL row treatment: full width, the same rounded
        // background, and the same `chat.composer` identifier (the editor sets that
        // one on its own UITextView). So crossing the threshold mid-draft changes
        // the field's cost model and nothing a user or a maestro flow can observe.
        Group {
            if useLongDraftEditor {
                LongDraftEditor(text: draft, isFocused: $longDraftFocused)
            } else {
                TextField(busy ? "Waiting for reply…" : placeholder, text: draft, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 9)
                    .focused($focused)
                    .accessibilityIdentifier("chat.composer")
            }
        }
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    /// The bottom control row: `+`, model pill, then mic and send pushed right.
    ///
    /// UNCONDITIONAL, because it owns mic and send, so it exists on every composer.
    /// Only the PILL is conditional (`showsModelPill`), and it is a chip shorter
    /// than the 32pt buttons beside it, so its arrival cannot change the row's
    /// height.
    ///
    /// DELIBERATELY NO IDENTIFIER ON THE HSTACK. An id here would flatten onto
    /// every descendant and clobber `chat.plus` / `composer.modelPill` /
    /// `chat.mic` / `chat.send` (the lesson `pendingVoiceRow` records, learned when
    /// Maestro stopped finding `chat.voiceRetry`), and the `children: .contain`
    /// that makes a container id safe would still add an accessibility element no
    /// flow asks for. The row's existence is already observable through
    /// `chat.mic`, which is always on it. Leaving the wrapper bare keeps this
    /// restructure provably a no-op for the accessibility tree.
    private var bottomControlRow: some View {
        HStack(spacing: 8) {
            plusButton
            // The pill is the only flexible thing on this row: its label is
            // `lineLimit(1)` and the three buttons carry fixed 32pt frames, so an
            // absurdly long model name TRUNCATES rather than shoving send off the
            // edge. (Worst real label today, "GPT-5.6 Sol · Extra High", has ~246pt
            // of room on a 390pt phone, so truncation is the guard rail and not the
            // everyday case.)
            if showsModelPill {
                ComposerModelPill(controls: controls)
            }
            Spacer(minLength: 0)
            // Mic is ALWAYS present — transcription appends to the draft, so
            // voice input composes with typed text instead of replacing it.
            // The send button joins it once there's something to send.
            micButton
            if hasContent {
                sendButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    /// Horizontal strip of picked-image thumbnails above the field, each with a
    /// remove affordance. Sits between any notices and the field row.
    private var thumbnailStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(selectedImages) { image in
                    ZStack(alignment: .topTrailing) {
                        Image(uiImage: image.thumbnail)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Button {
                            drafts.setImages(
                                selectedImages.filter { $0.id != image.id }, key: draftKey
                            )
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 18))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.55))
                                .padding(3)
                        }
                        .accessibilityIdentifier("chat.imageRemove")
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
        }
    }

    /// Saved-but-untranscribed recordings: retry / discard, styled like the
    /// notice rows (non-modal, dismiss-optional — matches the failed-send
    /// bubble's Retry pattern).
    private var pendingVoiceRow: some View {
        HStack(spacing: 6) {
            Image(systemName: "waveform.badge.exclamationmark")
                .font(.caption2)
            Text(voice.pendingCount == 1
                 ? "1 recording saved — transcription pending"
                 : "\(voice.pendingCount) recordings saved — transcription pending")
                .font(.caption)
                .lineLimit(2)
                // Row marker lives on the TEXT, not the container — a
                // container-level identifier flattens onto every child in the
                // accessibility tree and clobbers the buttons' own ids
                // (Maestro then can't find chat.voiceRetry).
                .accessibilityIdentifier("chat.voicePendingRow")
            Spacer(minLength: 0)
            Button("Retry") {
                Task {
                    if let text = await voice.retryPending() {
                        appendToDraft(text)
                    }
                }
            }
            .font(.caption.weight(.semibold))
            .accessibilityIdentifier("chat.voiceRetry")
            Button {
                voice.discardPending()
            } label: {
                Image(systemName: "trash")
                    .font(.caption2)
            }
            .accessibilityIdentifier("chat.voiceDiscardPending")
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    /// Recording in progress: cancel × — pulsing dot + elapsed — stop ✓.
    /// A quick-action take swaps the label copy ("Send to Walnut") so the user
    /// knows stopping SENDS rather than dropping text into a field to review.
    private var recordingRow: some View {
        HStack(spacing: 12) {
            Button {
                // Cancel is the user's explicit "never mind" — it deletes the
                // audio (the one sanctioned deletion), so the quick action's
                // auto-send arming dies with it.
                voice.cancel()
                quickAction.clear(reason: "cancelled")
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .accessibilityIdentifier("chat.voiceCancel")

            RecordingIndicator(
                elapsed: voice.elapsed,
                caption: quickAction.autoSendArmed ? "Recording — stop to send" : "Recording…"
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                Task {
                    if let text = await voice.stopAndTranscribe() {
                        deliver(text)
                    }
                    // Transcription FAILED (or heard nothing): the audio is
                    // preserved and the pending-retry row is now showing. Disarm
                    // auto-send so a later manual Retry lands in the draft for
                    // review — an unattended send of text the user never saw,
                    // minutes after they spoke, is worse than a visible draft.
                    else if quickAction.autoSendArmed {
                        quickAction.clear(reason: "transcribe-failed")
                    }
                }
            } label: {
                Image(systemName: quickAction.autoSendArmed ? "arrow.up" : "checkmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Theme.onTint)
                    .frame(width: 32, height: 32)
                    .background(Theme.tint, in: Circle())
            }
            .accessibilityIdentifier("chat.voiceStop")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }

    // MARK: - Buttons

    /// The `+`: attachments, plus READ-ONLY host provenance ("where is this
    /// served from"). Two items, so it is not a junk drawer: everything that
    /// changes the NEXT message stays on the row (model pill) or in the row's
    /// own buttons (mic, send), and everything that is a fact about the session
    /// stays in the session menu. If a third item ever wants in here, it has to
    /// argue that it is an INPUT to the message the user is composing.
    ///
    /// The host row is what the user asked for in the `+` specifically ("可能在那个
    /// 加号里显示这是哪个 host"), and it stays READ-ONLY: `ComposerHostProvenance`
    /// is the single source of truth for how this app names an exec host, and it
    /// answers two different questions (a session's chosen host vs which server is
    /// answering the main agent) without letting either pretend to be a picker.
    /// Host is only choosable at session CREATION, so a chooser here would be a
    /// control that cannot change anything.
    ///
    /// Keeps `chat.photo` as the photo item's identifier: existing automation taps
    /// it, and the id must keep meaning "open the photo picker". The menu itself
    /// gets `chat.plus` (a collapsed Menu renders as one accessibility element, so
    /// the container needs its own id — the same lesson TasksView's
    /// `sessions.new`/`sessions.create` pair encodes).
    private var plusButton: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label(
                    selectedImages.isEmpty ? "Photos" : "Photos (\(selectedImages.count)/\(Self.maxImages))",
                    systemImage: "photo"
                )
            }
            .disabled(selectedImages.count >= Self.maxImages)
            .accessibilityIdentifier("chat.photo")

            if let hostProvenance {
                ComposerHostRow(provenance: hostProvenance)
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(.tertiarySystemFill), in: Circle())
        }
        // No bottom nudge any more: the old `.padding(.bottom, 3)` on all three
        // buttons optically aligned 32pt circles against a field that grew to six
        // lines beside them. On a dedicated control row there is nothing to align
        // against, so the nudge would just be an asymmetric row.
        .accessibilityIdentifier("chat.plus")
    }

    private var micButton: some View {
        Button {
            Task { _ = await voice.start() }
        } label: {
            if voice.state == .transcribing {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 32, height: 32)
            } else {
                Image(systemName: "mic.fill")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
        }
        .disabled(voice.state != .idle)
        .accessibilityIdentifier("chat.mic")
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(canSend ? Theme.onTint : Color(.tertiaryLabel))
                .frame(width: 32, height: 32)
                .background(canSend ? Theme.tint : Color(.tertiarySystemFill), in: Circle())
        }
        .disabled(!canSend)
        .accessibilityIdentifier("chat.send")
    }

    // MARK: - Actions

    private func send() {
        let text = trimmed
        let images = selectedImages
        guard !text.isEmpty || !images.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        FreezeContext.shared.note("send", text.utf8.count)
        FreezeContext.shared.setDraftChars(0)
        drafts.clear(draftKey)
        pickerItems = []
        // Failure keeps the text AND images as a failed bubble in the timeline
        // (store's contract) — nothing restored here, so new typing/picking is
        // never clobbered.
        Task { _ = await onSend(text, images) }
    }

    /// Decode + downscale + JPEG-encode picked items off the main actor, then
    /// merge into the selection (respecting the 5-image ceiling AND the total
    /// payload budget). Surfaces a dismissible notice for images that are too
    /// large, over budget, or failed to decode.
    private func loadPicked(_ items: [PhotosPickerItem]) async {
        var current = selectedImages
        var tooLarge = 0
        var failed = 0
        var overBudget = 0
        // Each image is individually capped at 10MB base64, so five of them can
        // build ~50MB of concurrent base64 in the send path — enough to get the
        // app jetsammed on a warm device. Enforce the AGGREGATE too, and do it
        // here (at pick time) so the user learns immediately instead of after
        // composing a message that can never be sent.
        var budgetUsed = current.reduce(0) { $0 + SelectedImage.base64Length($1.jpegData) }
        let room = Self.maxImages - current.count
        for item in items.prefix(max(0, room)) {
            switch await SelectedImage.load(from: item) {
            case .ok(let image):
                let cost = SelectedImage.base64Length(image.jpegData)
                if budgetUsed + cost > SelectedImage.maxTotalBase64Length {
                    overBudget += 1
                } else {
                    budgetUsed += cost
                    current.append(image)
                }
            case .tooLarge: tooLarge += 1
            case .failed: failed += 1
            }
        }
        drafts.setImages(current, key: draftKey)
        pickerItems = []
        if tooLarge > 0 || failed > 0 || overBudget > 0 {
            var parts: [String] = []
            if tooLarge > 0 { parts.append("\(tooLarge) too large to send") }
            if overBudget > 0 { parts.append("\(overBudget) over the total attachment size limit") }
            if failed > 0 { parts.append("\(failed) couldn't be read") }
            imageNotice = "Some images were skipped: \(parts.joined(separator: ", "))."
        }
    }

    // MARK: - Voice Quick Action

    /// Where a finished transcription goes. Normal mic taps compose into the
    /// draft (the user reviews and hits send); a quick-action take sends
    /// straight through, because "one action, then talk" is the whole point.
    ///
    /// Auto-send arming is consumed here, once. Everything downstream is the
    /// store's ordinary send path — including its no-loss guarantee: a failed
    /// send stays in the timeline as a retryable failed bubble holding the full
    /// transcript, so the words survive even when the network doesn't.
    private func deliver(_ text: String) {
        guard quickAction.takeAutoSend() else {
            appendToDraft(text)
            return
        }
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Nothing to send: fall back to the draft so the user still sees
        // whatever came back rather than losing it to a silent no-op.
        guard !trimmedText.isEmpty else {
            appendToDraft(text)
            return
        }
        AppLog.info("voice", "quick action transcript auto-sent", ["chars": "\(trimmedText.count)"])
        FreezeContext.shared.note("voice-quick-send", trimmedText.utf8.count)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { _ = await onSend(trimmedText, []) }
    }

    /// Open the mic for a pending Home-screen quick action.
    ///
    /// Every guard here is load-bearing:
    ///  - `acceptsVoiceQuickAction`: session composers must not steal it.
    ///  - `onScreen`: a retained off-screen tab must never open the mic.
    ///  - `disabled` (offline): recording would be fine, but the SEND wouldn't,
    ///    and a quick action whose entire promise is "it reaches the agent"
    ///    should not silently become a draft. Leave the request for the next
    ///    appear (inside its TTL) instead of burning it.
    ///  - `voice.state == .idle`: a take is already running; do not restart it.
    private func consumeVoiceQuickActionIfPending() {
        guard acceptsVoiceQuickAction, onScreen, !disabled, voice.state == .idle else { return }
        guard quickAction.consume() != nil else { return }
        // Point the composer at the MAIN agent before the mic opens, so a user
        // who last browsed a subagent still gets their sentence delivered to the
        // Personal AI (the quick action's contract).
        prepareVoiceQuickAction?()
        quickAction.autoSendArmed = true
        Task {
            let started = await voice.start()
            if !started {
                // Permission denied / session failure — `voice.errorMessage` is
                // already on screen. Disarm so a later manual take isn't
                // unexpectedly auto-sent.
                quickAction.clear(reason: "start-failed")
            }
        }
    }

    private func appendToDraft(_ text: String) {
        let existing = draft.wrappedValue
        // Breadcrumb BEFORE the mutation: the append + focus pair is the
        // suspected trigger of the build-35 freeze, so the trail must show it
        // even if the very next layout pass is the one that wedges.
        FreezeContext.shared.note("append-draft", text.utf8.count)
        draft.wrappedValue = existing.isEmpty ? text : existing + " " + text
        // Focus whichever field the (now longer) draft renders in. Repeated
        // dictations are exactly how a draft crosses the threshold, so this
        // append may be the very mutation that swaps the field.
        if useLongDraftEditor { longDraftFocused = true } else { focused = true }
    }

    private func noticeRow(_ text: String, icon: String, onDismiss: (() -> Void)? = nil) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(2)
            if let onDismiss {
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Image(systemName: "xmark")
                        .font(.caption2)
                }
            }
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .frame(maxWidth: .infinity, alignment: onDismiss == nil ? .center : .leading)
    }
}

/// Pulsing red dot + elapsed time while the mic is live. `caption` states what
/// stopping will DO — a quick-action take sends, a normal take fills the draft.
private struct RecordingIndicator: View {
    let elapsed: TimeInterval
    var caption: String = "Recording…"
    @Environment(\.scenePhase) private var scenePhase
    @State private var phase = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Theme.danger)
                .frame(width: 10, height: 10)
                .opacity(phase ? 0.35 : 1)
                .animation(
                    scenePhase == .active ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true) : nil,
                    value: phase
                )
            Text(timeString)
                .font(.callout.monospacedDigit().weight(.medium))
            Text(caption)
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("chat.voiceRecordingCaption")
        }
        .onAppear { phase = scenePhase == .active }
        .onChange(of: scenePhase) { _, phaseState in
            phase = phaseState == .active
        }
    }

    private var timeString: String {
        let s = Int(elapsed)
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

/// Chat tab's composer — a thin ChatStore wrapper around ComposerBar.
/// `busy` gates the send button while a turn runs (contract: 409 turn_active);
/// typing stays available the whole time.
struct ComposerView: View {
    @Environment(ChatStore.self) private var chat
    @Environment(ConnectionStore.self) private var connection

    var body: some View {
        ComposerBar(
            // A pending structured question re-opens the composer: the send
            // routes to the answer endpoint (ChatStore.send intercepts).
            placeholder: chat.pendingQuestion
                ? "Answer \(chat.activeAgentName)'s question"
                : "Message \(chat.activeAgentName)",
            busy: (chat.sending || chat.streaming) && !chat.pendingQuestion,
            disabled: !connection.online,
            disabledNotice: connection.online ? nil : "Offline — reconnecting…",
            // Per-conversation draft. A brand-new (unsaved) conversation shares
            // the agent-scoped key so text typed before the server assigns an id
            // isn't orphaned when it does.
            draftKey: "chat:\(chat.activeID ?? "new-\(chat.activeAgentID)")",
            // The SCREEN, which the draft key above deliberately is not: the key
            // follows the conversation (and is nil-then-real across hydration), while
            // the surface is "the Chat tab" for this composer's whole life. The dock's
            // clearance is derived from the surface, so switching conversations or
            // agents can no longer leave a second chat composer registered forever
            // (the 2026-08-30 P1 — see `ComposerSurfaceID`).
            surface: .chatTab,
            // The chat composer is the ONLY consumer of the Home-screen voice
            // Quick Action — it is the surface that talks to the main agent.
            acceptsVoiceQuickAction: true,
            prepareVoiceQuickAction: {
                // The shortcut promises the MAIN agent. If the user last left
                // chat on a subagent, switch home before the mic opens (a no-op
                // when already there).
                chat.switchAgent(ChatStore.mainAgentID)
            },
            // The MAIN AGENT gets a model pill too. On the lane engine its turn
            // runs inside a real CLI session, so the model is a genuine per-
            // conversation property (GET /chat/engine resolves which session);
            // on the in-process engine the pill goes read-only and says so,
            // because the model is then a server-config fact.
            modelSource: .chat(agentID: chat.activeAgentID, conversationID: chat.activeID),
            // The main agent does NOT run on a selectable exec host: it runs
            // wherever the server runs. So the honest provenance is which SERVER
            // is answering (primary vs cloud companion), and whether the Mac is
            // still reachable from it.
            hostProvenance: .chat(status: connection.status, online: connection.online)
        ) { text, images in
            await chat.send(text, images: images)
        }
    }
}

// MARK: - Banners

struct OfflineBanner: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "wifi.slash")
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(Theme.warning.opacity(0.15))
            .foregroundStyle(.primary)
    }
}

struct ErrorBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.danger.opacity(0.12))
        .foregroundStyle(.primary)
    }
}

/// Green success line for lifecycle confirmations ("Session restarted").
struct ConfirmationBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack {
            Label(text, systemImage: "checkmark.circle.fill")
                .font(.footnote)
                .lineLimit(2)
            Spacer()
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(Theme.success.opacity(0.12))
        .foregroundStyle(.primary)
        .task {
            // Self-dismiss: success lines are transient by nature.
            try? await Task.sleep(for: .seconds(5))
            onDismiss()
        }
    }
}
