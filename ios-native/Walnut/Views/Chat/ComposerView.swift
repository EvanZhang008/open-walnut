import SwiftUI
import PhotosUI
import AVFoundation

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
/// Image input: the `+` menu offers two sources, and they converge immediately.
/// Photos opens the native PhotosPicker (iOS 16+, sandboxed — no photo-library
/// permission prompt); Take Photo opens the system camera (`CameraPicker`) and is
/// omitted where no camera exists. Both hand their image to
/// `SelectedImage.make` and then to the SAME merge (`attach`), so one set of
/// rules covers both: 1568px longest edge, JPEG 0.8 falling back to 0.5, five
/// images, the aggregate base64 budget, and one notice naming whatever was
/// skipped. Results show as a removable thumbnail strip above the field, and the
/// server cannot tell a capture from a pick.
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
    /// A turn is running but BLOCKED on a structured question, so this composer
    /// is its answer field: send stays live (it routes to /answer) and the
    /// primary button must not offer to stop the turn that is waiting here.
    var pendingQuestion: Bool = false
    /// Abort the running turn. Absent = this composer has nothing to interrupt
    /// (the new-session launcher is `busy` while it CREATES a session), and the
    /// primary button keeps its greyed-send treatment.
    var onStop: (() async -> Void)? = nil
    var disabled: Bool = false
    var disabledNotice: String? = nil
    /// A sentence the OWNER wants in the composer's notice row (today: the send
    /// queue's ceiling). Derived from store state rather than latched here, so it
    /// appears while the limit is reached and clears itself when it is not.
    var ownerNotice: String? = nil
    /// Can this composer's owner HOLD a send made while it is busy?
    ///
    /// True for the chat composer, whose store banks the message and delivers it
    /// when the turn settles. FALSE BY DEFAULT, and the default is the load-bearing
    /// half: the new-session launcher is `busy` while it creates a session, and a
    /// second send there creates a SECOND session.
    var busyAcceptsSend: Bool = false
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
    /// Returns **"are these words safe with you"**, which is deliberately NOT "did
    /// the send succeed". Stores here own no-loss: a dead round trip becomes a
    /// retryable failed bubble that still holds the full text, and that counts as
    /// safe. Only a store that refused BEFORE keeping anything answers false.
    ///
    /// The distinction exists because voice is the one caller holding the only copy
    /// of the text (the audio is deleted the moment transcription succeeds), so it
    /// acts on this Bool. Answering it as "did it succeed" put the same sentence in
    /// the timeline AND the draft. See `voiceRescueReason` and
    /// `ComposerView.sendKeepingWords`.
    let onSend: (String, [SelectedImage]) async -> Bool

    /// Optional so roots that never inject a dock still build (RootView's DEBUG
    /// harness entry points bypass the store wiring), and so a composer inside a
    /// sheet is not required to have one.
    @Environment(FilePreviewDock.self) private var dock: FilePreviewDock?

    /// Drives the published-height channel's two lifecycle rules: a retraction is
    /// only honest while the app is active, and returning from the background
    /// re-asserts the measurement (see the three publishers on the body).
    @Environment(\.scenePhase) private var scenePhase

    /// Only the notice rows read this: their `lineLimit(2)` is a truncation machine at
    /// accessibility text sizes (see `noticeRow`).
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Last height this composer measured, so returning to a retained tab or coming
    /// back from the background can re-publish it (see the publishers on the body).
    @State private var measuredHeight: CGFloat = 0

    /// Last width this composer measured. The composer spans the window, so this IS the
    /// width available to anything it presents, and the `+` popover derives its
    /// accessibility-size width from it (see `attachmentMenuWidth`).
    @State private var measuredWidth: CGFloat = 0

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
    /// camera + host provenance), so the picker is presented rather than being the
    /// button.
    ///
    /// TWO independent flags, and they must NEVER both be true. A `.photosPicker`
    /// and a `.fullScreenCover` raised from the same view in the same frame is a
    /// UIKit presentation conflict: one of them silently loses and which one is an
    /// ordering detail. The attachment popover reports exactly one tap, so the only
    /// route to both is a flag left set by a presentation that already ended, hence
    /// each opener lowers its sibling first (`openPhotoPicker` / `openCamera`), and
    /// neither dismissal ever raises the other.
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    /// The `+` popover. A popover rather than a `Menu` because a context menu over the
    /// keyboard dropped the tapped row's action outright (see `plusButton`).
    @State private var showAttachmentMenu = false
    /// Camera access is already DENIED, so the tap gets a sentence instead of a
    /// black viewfinder. Its own notice (not `imageNotice`) so an unrelated
    /// "images were skipped" line cannot clobber the one row that tells the user
    /// how to fix it.
    @State private var cameraNotice: String?
    /// A send the owner would not keep, so the words are back in the field. Local
    /// (not owner-supplied) because the owner that refused may have nothing to say
    /// about it — see `send()`.
    @State private var refusedNotice: String?

    /// Not private: `attach` is the shared rule and its tests assert against the
    /// real ceiling rather than re-declaring a 5.
    static let maxImages = 5

    /// The `+` menu's identifiers. Constants because both the view and the menu
    /// model below spell them, and `chat.photo` in particular is a contract with
    /// existing automation: it must keep meaning "open the photo picker".
    static let photoItemID = "chat.photo"
    static let cameraItemID = "chat.camera"
    /// `ComposerHostRow`'s own id, spelled here only so the menu model below can
    /// state the full order. The row itself still owns it.
    static let hostRowItemID = "composer.hostRow"

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
    /// A turn is running AND this composer is not the field it is waiting on.
    /// Now read by ONE thing, the field's placeholder: it is the honest caption
    /// for an EMPTY composer mid-turn, and an empty composer is the only time a
    /// placeholder is visible.
    private var waitingForReply: Bool { busy && !pendingQuestion }
    /// Blind to whether a turn is running only where the owner can HOLD the words.
    /// A chat send mid-turn is banked by the store and delivered when the turn
    /// settles, so gating on `waitingForReply` there refused words that had
    /// somewhere to go and left a user who had just dictated a paragraph with no way
    /// to send it. A composer whose owner cannot hold them keeps the old gate.
    private var canSend: Bool {
        Self.canSend(hasContent: hasContent, disabled: disabled,
                     waitingForReply: waitingForReply, busyAcceptsSend: busyAcceptsSend)
    }

    /// Whether a tap on the send button is ACCEPTED, as a pure rule.
    ///
    /// Static because the button's appearance and its action have to agree, and the
    /// two used to be decided in different places: `ComposerPrimaryAction` said
    /// "send" while this said no, so the seat looked live and the tap did nothing.
    static func canSend(hasContent: Bool, disabled: Bool, waitingForReply: Bool,
                        busyAcceptsSend: Bool) -> Bool {
        hasContent && !disabled && (!waitingForReply || busyAcceptsSend)
    }
    private var primaryAction: ComposerPrimaryAction {
        ComposerPrimaryAction
            .decide(busy: busy, hasContent: hasContent, pendingQuestion: pendingQuestion,
                    busyAcceptsSend: busyAcceptsSend)
            .availableWithStop(onStop != nil)
    }

    var body: some View {
        VStack(spacing: 0) {
            if disabled, let notice = disabledNotice {
                noticeRow(notice, icon: Symbol.offlineNotice)
            }
            // The owner's sentence when it has one (it names the actual ceiling), the
            // generic refusal otherwise. Never both: two rows about one refused tap
            // is noise, and the specific one is always the more useful.
            if let notice = ownerNotice ?? refusedNotice {
                noticeRow(notice, icon: Symbol.queueFullNotice) {
                    refusedNotice = nil
                }
            }
            if let voiceError = voice.errorMessage {
                noticeRow(voiceError, icon: Symbol.voiceErrorNotice) {
                    voice.errorMessage = nil
                }
            }
            if let imageNotice {
                noticeRow(imageNotice, icon: Symbol.imageNotice) {
                    self.imageNotice = nil
                }
            }
            // Camera access denied. The same row the image and voice notices use —
            // the mic's "enable it in Settings" line is the precedent, and a
            // permission dead end deserves the same non-modal, dismissible shape
            // rather than an alert that interrupts a half-typed message.
            //
            // `lock.slash`, NOT the `camera.slash` this was first written with: there is
            // no such symbol (only `camera.macro.slash`), so the row rendered an
            // EMPTY 0pt glyph and the sentence sat against the margin. A wrong
            // symbol name fails silently, which is why `ComposerCameraTests` now
            // resolves every icon this file names. The padlock is also the honest
            // subject: the camera works, the permission is off.
            if let cameraNotice {
                noticeRow(cameraNotice, icon: Symbol.cameraDeniedNotice) {
                    self.cameraNotice = nil
                }
            }
            // Preserved voice takes (failed upload / interruption / crash /
            // view dismissal) — non-modal retry affordance. Audio is never
            // deleted until it transcribes or the user explicitly discards.
            //
            // TWO rows, because they are two different situations and one row
            // saying "pending" for both is the defect: a take waiting for the
            // network gets a Retry, a take the engine has already answered on
            // gets the truth and a Discard.
            if voice.state == .idle, voice.pendingCount > 0 {
                pendingVoiceRow
            }
            if voice.state == .idle, voice.failedCount > 0 {
                failedVoiceRow
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
        // Width, in its OWN observer rather than folded into a `CGSize` above. The height
        // feeds the dock through a level-triggered publisher with its own re-assert
        // rules; a combined observer would make every width change re-report a height
        // the dock already holds. This one only ever feeds the `+` popover's width rule.
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { width in
            if width > 0 { measuredWidth = width }
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
        // The camera, full screen (a viewfinder in a sheet is a viewfinder with a
        // gesture that dismisses it mid-shot). Both exits lower the flag and
        // NOTHING else touches the draft: a cancel returns to exactly the text and
        // attachments the user left, which is this composer's standing rule.
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker(
                onCapture: { image in
                    showCamera = false
                    Task { await attachCaptured(image) }
                },
                onCancel: { showCamera = false }
            )
            .ignoresSafeArea()
        }
        .onAppear {
            onScreen = true
            if let modelSource {
                controls.attach(modelSource, fallbackModel: fallbackModel)
            }
            // An interruption (call / Siri) auto-transcribes the partial take.
            // For a quick-action take that text is still owed to the agent —
            // route it the same way a normal stop would.
            voice.onAutoStopText = { text in deliver(text) }
            // Automatic drain results go STRAIGHT to the draft, never through
            // `deliver` — a take recovered in the background must not be able to
            // reach the auto-send path (see `VoiceRecorder.onDrainedText`).
            voice.onDrainedText = { text in appendToDraft(text) }
            // WHO this recorder speaks for. The store is process-global while every
            // composer owns its own `@State` recorder, so without an identity the
            // automatic drain had no way to tell "my backlog" from "someone else's":
            // a take dictated into the Chat tab was silently transcribed by a session
            // composer and appended to THAT session's draft, with no tap in between
            // (verifier finding F5). The surface FAMILY is the right grain — the chat
            // tab keeps one identity across conversations (`draftKey` changes per
            // conversation, the surface does not), and a session composer answers only
            // for its own session.
            voice.surface = surface.raw.isEmpty ? draftKey : surface.raw
            // Takes with no recorded origin (preserved by a build that predates the
            // stamp) need exactly one adopter, or they are either drained by everybody
            // or by nobody. The quick-action composer is that adopter: it is the
            // surface the Home-screen shortcut talks to, so it is where an
            // unattributable recording most likely came from.
            voice.ownsOrphanTakes = acceptsVoiceQuickAction
            // Crash/relaunch recovery: takes preserved by an earlier run (or
            // by another composer instance) surface here as the retry row.
            voice.refreshPending()
            // …and are actually retried, not just counted. A fresh launch never
            // crosses a scene-phase edge, so `resumeForForeground` does not fire
            // and this is the only drain trigger a relaunch gets.
            if !disabled { voice.drainPending(trigger: "composer-appear") }
            consumeVoiceQuickActionIfPending()
        }
        // Warm launch: the shortcut arrives while this view is already mounted,
        // so onAppear never runs again — the mailbox change is the trigger.
        .onChange(of: quickAction.pending) { _, request in
            if request != nil { consumeVoiceQuickActionIfPending() }
        }
        // The two retriggers a deferred request needs, and the reason the field
        // report was "the shortcut does nothing": `consumeVoiceQuickActionIfPending`
        // can decline, and until now NOTHING re-asked. A long-press while the app
        // was offline, or while a transcription upload was still in flight (which
        // can run for minutes on a big take), was a silent no-op until the 120s
        // TTL quietly binned the request.
        .onChange(of: disabled) { _, isDisabled in
            // Reconnected: drain the backlog too. Same trigger, same moment —
            // the network coming back is exactly when preserved audio becomes
            // transcribable.
            if !isDisabled { voice.drainPending(trigger: "reconnected") }
            consumeVoiceQuickActionIfPending()
        }
        .onChange(of: voice.state) { _, _ in
            consumeVoiceQuickActionIfPending()
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

    // MARK: - The `+` menu's model

    /// No room for another attachment. Both sources are disabled at the ceiling
    /// rather than accepting an image the merge would then drop.
    private var atImageCeiling: Bool { selectedImages.count >= Self.maxImages }

    /// The `+` menu's items, as their accessibility identifiers, in order.
    ///
    /// The SPEC for the menu's shape, as a pure function, because the two things
    /// worth pinning cannot be asserted any other way: that Take Photo sits
    /// directly after Photos (the two image sources read as a pair, with the
    /// read-only host row last), and that it is ABSENT rather than disabled when
    /// there is no camera. Availability is a PARAMETER rather than a call into
    /// UIKit so that both branches are reachable from a test: no machine here
    /// reports both answers (the iPhone 16 Pro simulator on iOS 26 answers TRUE and
    /// presents a working picker, contrary to the old "simulators have no camera"
    /// assumption), so a rule that asked UIKit for itself could only ever be
    /// exercised one way.
    static func plusMenuItems(cameraAvailable: Bool, hasHostProvenance: Bool) -> [String] {
        var items = [photoItemID]
        if cameraAvailable { items.append(cameraItemID) }
        if hasHostProvenance { items.append(hostRowItemID) }
        return items
    }

    /// What a source row is called, given how many images are already attached.
    ///
    /// BOTH sources get the count, and that is the point: at the ceiling both rows
    /// are disabled, and a greyed row with no number is a control that refuses
    /// without saying why. Take Photo shipped greyed and silent while Photos read
    /// "Photos (5/5)" right above it.
    static func attachmentSourceLabel(_ base: String, attached: Int) -> String {
        attached == 0 ? base : "\(base) (\(attached)/\(maxImages))"
    }

    /// The `+` popover's width at ordinary text sizes: menu-shaped, and the geometry
    /// every screenshot of this menu has been taken at.
    static let defaultAttachmentMenuWidth: CGFloat = 260
    /// Room the popover leaves on each side of the window, so it cannot be clipped by
    /// the edge and its arrow keeps a place to point from.
    static let attachmentMenuSideMargin: CGFloat = 16
    /// Floor, for a window narrower than any shipping phone. Better a menu with some
    /// wrapping than one 40pt wide.
    static let minAttachmentMenuWidth: CGFloat = 200

    /// How wide the `+` popover may be, given the text size and the width it has to
    /// live inside.
    ///
    /// 260pt at ordinary sizes, unchanged. At accessibility sizes 260pt is a truncation
    /// machine: at accessibility-XXXL "Photos" alone rendered "Phot…" and
    /// "Take Photo (5/5)" lost its count. Nothing in an accessibility audit can see
    /// that, which is why it survived one: the accessibility LABEL stays complete, and
    /// only the pixels truncate. So this returns a real number rather than a guess.
    ///
    /// Derived from the MEASURED width, never a constant. A width that fits the 402pt
    /// phone this was verified on would be clipped on a narrower one: the rule yields
    /// 370 at 402pt, 343 at 375pt, and 288 at 320pt, the narrowest screen still in
    /// support. An unmeasured width (0 before the first layout, and during the
    /// zero-height snapshot pass a backgrounding triggers) falls back to the shipped
    /// 260 rather than collapsing to the floor.
    ///
    /// Width is only half the fix. No width fits "Take Photo (5/5)" on one line at the
    /// largest accessibility size, so the row's visible text also wraps without a line
    /// limit (see `attachmentSourceRow`).
    static func attachmentMenuWidth(
        isAccessibilitySize: Bool, availableWidth: CGFloat
    ) -> CGFloat {
        guard availableWidth > 0 else { return defaultAttachmentMenuWidth }
        let widestThatFits = max(
            minAttachmentMenuWidth, availableWidth - 2 * attachmentMenuSideMargin
        )
        guard isAccessibilitySize else { return min(defaultAttachmentMenuWidth, widestThatFits) }
        return widestThatFits
    }

    /// What a Take Photo tap does.
    enum CameraTapOutcome: Equatable {
        /// Open the picker. Includes the UNDECIDED case: presenting the picker is
        /// what raises the system permission prompt, so the first tap asks.
        case present
        /// Say why, in the composer's notice row, instead of opening a camera the
        /// user cannot see through.
        case notice(String)
    }

    /// Denied (or restricted) camera access. Names Settings, because that is the
    /// only place the user can undo it — the system prompt is asked once and never
    /// again, so a bare "camera unavailable" would be a dead end. Two sentences
    /// rather than one long line: the row caps at two lines at ordinary text sizes
    /// (and wraps freely at accessibility sizes, see `noticeRow`).
    static let cameraDeniedNotice =
        "Camera access is off. Enable it in Settings to take a photo."
    /// Unreachable through the UI (the item is hidden with no camera), kept as the
    /// honest answer if it ever is reached — never a misleading permission story.
    static let cameraUnavailableNotice = "This device has no camera to take a photo with."

    /// EVERY SF Symbol this composer draws, named once and drawn from here.
    ///
    /// A misspelled symbol does not throw, warn, or draw a placeholder: it draws a
    /// 0pt blank. The camera notice's first draft used `camera.slash`, which does not
    /// exist, and the blank icon was only caught by looking at a screenshot.
    ///
    /// The list has to be the SAME strings the views use, or the test that resolves
    /// it proves nothing about what is on screen — a review finding against the
    /// first cut, where `symbolNames` was a parallel copy no view read. So every
    /// `Image(systemName:)` and `Label(_:systemImage:)` below spells a case of this
    /// enum, and `all` is what `ComposerCameraTests` resolves.
    enum Symbol {
        static let plus = "plus"
        static let photo = "photo"
        static let camera = "camera"
        static let mic = "mic.fill"
        static let send = "arrow.up"
        static let stop = "stop.fill"
        /// Stop a recording that lands in the draft (vs `send`, which auto-sends).
        static let confirm = "checkmark"
        static let cancel = "xmark"
        static let removeImage = "xmark.circle.fill"
        static let offlineNotice = "exclamationmark.circle"
        static let voiceErrorNotice = "mic.slash"
        static let imageNotice = "photo.badge.exclamationmark"
        /// The padlock, NOT a slashed camera: `camera.slash` is not in the catalog
        /// (only `camera.macro.slash`), and the padlock is the honest subject
        /// anyway — the camera works, the permission is off.
        static let cameraDeniedNotice = "lock.slash"
        /// The send queue is full. A tray, not a warning triangle: nothing is
        /// wrong, there is simply no more room until one goes out.
        static let queueFullNotice = "tray.full"
        static let voicePending = "waveform.badge.exclamationmark"
        static let voiceFailed = "waveform.slash"
        static let discard = "trash"

        static let all = [
            plus, photo, camera, mic, send, stop, confirm, cancel, removeImage,
            offlineNotice, voiceErrorNotice, imageNotice, cameraDeniedNotice,
            queueFullNotice, voicePending, voiceFailed, discard,
        ]
    }

    /// A static pure function so the one rule that decides between a viewfinder and
    /// a sentence is assertable without a camera, a device, or a hosted view.
    ///
    /// `.notDetermined` DELIBERATELY presents: the picker itself raises the system
    /// prompt, and pre-asking with `requestAccess` would put our own timing between
    /// the tap and the alert for no gain. Only an already-denied state is
    /// intercepted, because a picker presented then shows a black frame with no
    /// explanation of what went wrong.
    static func cameraTapOutcome(
        available: Bool, authorization: AVAuthorizationStatus
    ) -> CameraTapOutcome {
        guard available else { return .notice(cameraUnavailableNotice) }
        switch authorization {
        case .denied, .restricted: return .notice(cameraDeniedNotice)
        case .authorized, .notDetermined: return .present
        // A status this build has never heard of is not a reason to refuse the
        // user's tap: let the picker decide, since it owns the prompt anyway.
        @unknown default: return .present
        }
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
                TextField(waitingForReply ? "Waiting for reply…" : placeholder, text: draft, axis: .vertical)
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
            // ONE trailing seat: send, or stop while a turn runs. Never both, so
            // a turn starting cannot shuffle the row's buttons sideways.
            if hasContent || primaryAction == .stop {
                primaryButton
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
                            Image(systemName: Symbol.removeImage)
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

    /// Saved-but-untranscribed recordings that STILL HAVE A REAL CHANCE: retry /
    /// discard, styled like the notice rows (non-modal, dismiss-optional —
    /// matches the failed-send bubble's Retry pattern).
    ///
    /// "Pending" is now a claim this row has to earn. It appears only for takes
    /// whose failures were transport-shaped (offline, sleeping Mac, dropped
    /// upload), which really are pending — the auto-drain will pick them up on
    /// the next foreground or reconnect without the user doing anything, and
    /// Retry is the manual version of the same thing.
    private var pendingVoiceRow: some View {
        HStack(spacing: 6) {
            Image(systemName: Symbol.voicePending)
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
                Image(systemName: Symbol.discard)
                    .font(.caption2)
            }
            .accessibilityLabel("Discard saved recordings")
            .accessibilityIdentifier("chat.voiceDiscardPending")
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    /// Takes the engine has answered on and cannot transcribe.
    ///
    /// The row this one replaces said "transcription pending" about audio that
    /// was never going to be transcribed, offered Retry as the primary action,
    /// and reproduced the same empty answer on every tap — a banner with no exit
    /// (the 2026-08-30 report). So: the copy states the outcome, DISCARD is the
    /// primary action, and there is no Retry, because retrying identical bytes
    /// through the same engine is precisely the loop that never ended.
    ///
    /// Discard is the only button, not an automatic deletion: the audio is still
    /// the user's, and "we couldn't read it, so we threw it away" is the one
    /// thing this store must never do.
    private var failedVoiceRow: some View {
        HStack(spacing: 6) {
            Image(systemName: Symbol.voiceFailed)
                .font(.caption2)
            Text(voice.failedCount == 1
                 ? "1 recording couldn't be transcribed"
                 : "\(voice.failedCount) recordings couldn't be transcribed")
                .font(.caption)
                .lineLimit(2)
                .accessibilityIdentifier("chat.voiceFailedRow")
            Spacer(minLength: 0)
            // Secondary, and only for takes the ATTEMPT CEILING retired: nothing
            // ever judged that audio, so a woken Mac can still transcribe it and
            // refusing the attempt would turn a noisy banner into lost words. A
            // verdict-retired take gets no Retry at all — a third identical
            // answer is the loop this row exists to end.
            if voice.recoverableFailedCount > 0 {
                Button("Try again") {
                    Task {
                        if let text = await voice.retryPending(includeRetired: true) {
                            appendToDraft(text)
                        }
                    }
                }
                .font(.caption)
                .accessibilityIdentifier("chat.voiceRetryFailed")
            }
            Button("Discard") {
                voice.discardFailed()
            }
            .font(.caption.weight(.semibold))
            .accessibilityLabel("Discard recordings that couldn't be transcribed")
            .accessibilityIdentifier("chat.voiceDiscardFailed")
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
                Image(systemName: Symbol.cancel)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .accessibilityIdentifier("chat.voiceCancel")

            // The caption states what STOPPING will do, so it has to track the
            // connection too: an armed take that is currently offline will land
            // in the draft (see `deliver`), and promising "stop to send" then
            // would be the same silent-failure story from the other end.
            RecordingIndicator(
                elapsed: voice.elapsed,
                caption: quickAction.autoSendArmed && !disabled
                    ? "Recording — stop to send"
                    : "Recording…",
                deliverySource: quickAction.lastConsumedSource
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
                Image(systemName: quickAction.autoSendArmed ? Symbol.send : Symbol.confirm)
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

    /// A POPOVER, not a `Menu`, and that is the F1 fix. MEASURED on the iPhone 16 Pro
    /// simulator (iOS 26) on 2026-09-14: a SwiftUI `Menu` is a UIKit context-menu
    /// interaction, which REPARENTS this button into a `_UIReparentingView` under the
    /// hosting controller's view for as long as the menu is open. With the keyboard
    /// UP, a tap on an item made the interaction resign the first responder (the
    /// keyboard hides, so this composer's `safeAreaInset` relayouts underneath the
    /// open menu) and, in 7 of 21 trials, THE ITEM'S ACTION WAS NEVER INVOKED at all:
    /// no action log, the items still in the accessibility tree, the menu's snapshot
    /// stranded where the composer used to be, and the `+` missing from the control
    /// row because it was still inside the reparenting view. Keyboard DOWN was 6/6
    /// fine, which is why the report read as "over the keyboard it does nothing".
    ///
    /// The mechanism matters because it rules out the two obvious suspects, both of
    /// which were tried and measured at 0 for 1: raising the presentation flag on a
    /// later run-loop turn, and lowering focus before raising it. Neither can help
    /// when the action never runs. Making the menu's content constant did not help
    /// either (5/6, same as the baseline). A popover is a REAL presentation whose rows
    /// are ordinary Buttons in a view this file owns, so nothing reparents this button
    /// and the action is a plain closure call: 12/12 with the keyboard up and down.
    ///
    /// Everything else about the `+` is unchanged, deliberately: the same
    /// `chat.plus` / `chat.photo` / `chat.camera` identifiers automation already taps,
    /// the same order (the two image sources as a pair, read-only provenance last),
    /// and the same READ-ONLY `ComposerHostRow`: `ComposerHostProvenance` is the
    /// single source of truth for how this app names an exec host, and host is only
    /// choosable at session CREATION, so a chooser here would be a control that
    /// cannot change anything.
    ///
    /// Still not a junk drawer: everything that changes the NEXT message stays on the
    /// row (model pill) or in the row's own buttons (mic, send), and everything that
    /// is a fact about the session stays in the session menu. Anything that wants in
    /// here has to argue that it is an INPUT to the message being composed, which is
    /// exactly what Take Photo is: the user's report was "I can only pick a photo, I
    /// can't take one", and a camera shot is the same attachment from the other source.
    private var plusButton: some View {
        Button {
            showAttachmentMenu = true
        } label: {
            Image(systemName: Symbol.plus)
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
        // `.presentationCompactAdaptation(.popover)` is what keeps this a popover on
        // a phone; without it iOS adapts it to a sheet, which is a whole modal page
        // for two rows.
        .popover(isPresented: $showAttachmentMenu, arrowEdge: .bottom) {
            attachmentMenu.presentationCompactAdaptation(.popover)
        }
    }

    /// The `+` popover's rows, IN THE ORDER `plusMenuItems` states. The order is
    /// derived rather than re-spelled here so the rule that test file asserts is the
    /// rule this view draws.
    private var attachmentMenu: some View {
        let items = Self.plusMenuItems(
            cameraAvailable: CameraPicker.isAvailable,
            hasHostProvenance: hostProvenance != nil
        )
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element) { index, item in
                if index > 0 { Divider() }
                attachmentMenuRow(item)
            }
        }
        .frame(width: Self.attachmentMenuWidth(
            isAccessibilitySize: dynamicTypeSize.isAccessibilitySize,
            availableWidth: measuredWidth
        ))
    }

    @ViewBuilder
    private func attachmentMenuRow(_ item: String) -> some View {
        switch item {
        case Self.photoItemID:
            attachmentSourceRow(
                title: Self.attachmentSourceLabel("Photos", attached: selectedImages.count),
                icon: Symbol.photo, identifier: item, action: openPhotoPicker
            )
        case Self.cameraItemID:
            // Disabled at the five-image ceiling for the same reason the library item
            // is, and NAMED the same way: a greyed row with no number is a control
            // that refuses without saying why.
            attachmentSourceRow(
                title: Self.attachmentSourceLabel("Take Photo", attached: selectedImages.count),
                icon: Symbol.camera, identifier: item, action: openCamera
            )
        case Self.hostRowItemID:
            if let hostProvenance {
                ComposerHostRow(provenance: hostProvenance)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        default:
            EmptyView()
        }
    }

    /// One tappable source row, sized and spaced like the system menu row it replaces
    /// (a 44pt target: caption-height label plus 12pt above and below).
    private func attachmentSourceRow(
        title: String, icon: String, identifier: String, action: @escaping () -> Void
    ) -> some View {
        Button {
            // Lower the popover, then act. Dismiss-then-present in one transaction is
            // measured good here (12/12): unlike the context menu this replaces, a
            // popover's dismissal does not have to survive a first-responder change
            // to deliver this closure: the closure has already run.
            showAttachmentMenu = false
            action()
        } label: {
            Label {
                // Unlimited lines on the VISIBLE text, spelled out here rather than left
                // to the default. This is the half of the accessibility-size fix that a
                // wider popover cannot do on its own: at accessibility-XXXL no width
                // this menu could take fits "Take Photo (5/5)" on one line, so the row
                // has to grow downward instead of trailing off in an ellipsis.
                //
                // On the `Text`, not the accessibility label, because the two are
                // different strings and only one of them was broken: VoiceOver always
                // read "Take Photo (5/5)" in full while the eye saw "Take Photo (5…".
                // An assertion on the accessibility label is blind to this defect.
                Text(title)
                    .lineLimit(nil)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: icon)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(atImageCeiling ? Color.secondary : Color.primary)
        .disabled(atImageCeiling)
        .accessibilityIdentifier(identifier)
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
                Image(systemName: Symbol.mic)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
        }
        .disabled(voice.state != .idle)
        .accessibilityIdentifier("chat.mic")
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch primaryAction {
        case .stop: stopButton
        case .send, .disabled: sendButton
        }
    }

    /// Stop the running turn. Lives here rather than in the navigation bar (where
    /// it used to be) so it is under the thumb that just sent the message, and so
    /// the top-right of the chat can be empty.
    private var stopButton: some View {
        Button {
            Task { await onStop?() }
        } label: {
            Image(systemName: Symbol.stop)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(Theme.danger, in: Circle())
        }
        .accessibilityIdentifier("chat.stop")
        .accessibilityLabel("Stop")
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: Symbol.send)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(canSend ? Theme.onTint : Color(.tertiaryLabel))
                .frame(width: 32, height: 32)
                .background(canSend ? Theme.tint : Color(.tertiarySystemFill), in: Circle())
        }
        .disabled(!canSend)
        .accessibilityIdentifier("chat.send")
    }

    // MARK: - Actions

    /// Hand the composed message to the owner, and keep the field's contents alive
    /// unless the owner says it KEPT the words.
    private func send() {
        let text = trimmed
        let images = selectedImages
        guard !text.isEmpty || !images.isEmpty else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        pickerItems = []
        refusedNotice = nil
        Task {
            let disposition = await Self.deliver(
                text: text, images: images, draftKey: draftKey, drafts: drafts,
                onSend: onSend
            )
            // Silent when the owner already has a sentence on screen (`ownerNotice`
            // names the real ceiling); this covers every other refusal, where the
            // text reappearing with no explanation reads as a bug.
            if disposition == .returnedToDraft { refusedNotice = Self.refusedNotice }
        }
    }

    enum SendDisposition: Equatable {
        /// The owner is holding the words (a turn, a bubble, or its queue).
        case kept
        /// Nothing kept them, so they are back in the composer.
        case returnedToDraft
    }

    /// THE DRAFT IS THE LAST COPY, and this is the rule that decides whether it
    /// survives.
    ///
    /// Clearing the field up front and discarding `onSend`'s answer (which is what
    /// this did) deleted the text outright on every path where nothing kept it: the
    /// queue at its ceiling, a store with no conversation to bank against, a
    /// launcher whose create call failed. No bubble, no draft, no disk record — the
    /// message simply stopped existing, which is the exact harm the queue was built
    /// to prevent. The voice path has answered this question correctly for a while
    /// (`voiceRescueReason`); this is the keyboard reaching the same guarantee.
    ///
    /// The field still clears IMMEDIATELY, because that is the feel and because a
    /// composer still holding the text it just sent invites a second send. A refusal
    /// puts the words BACK. Only a refusal: the store's own contract is that a
    /// failed round trip already keeps them as a retryable bubble, so restoring on
    /// any false would put the same sentence in two places.
    ///
    /// Static, with the draft store passed in, so the decision is assertable without
    /// a hosted view — a tap handler is not a place to keep a no-loss rule.
    @MainActor
    static func deliver(
        text: String, images: [SelectedImage], draftKey: String,
        drafts: ComposerDrafts, onSend: (String, [SelectedImage]) async -> Bool
    ) async -> SendDisposition {
        FreezeContext.shared.note("send", text.utf8.count)
        FreezeContext.shared.setDraftChars(0)
        drafts.clear(draftKey)
        if await onSend(text, images) { return .kept }
        restoreRefusedDraft(text, images, draftKey: draftKey, drafts: drafts)
        return .returnedToDraft
    }

    /// Put a refused message back in the composer.
    ///
    /// MERGES rather than overwrites, because the round trip is not instant and the
    /// user may have started typing again in the window: the refused text goes
    /// FIRST (it was typed first) and whatever is in the field follows it. Images go
    /// back through the shared `attach` rule, so the 5-image ceiling and the
    /// aggregate byte budget are enforced on the restored set exactly as on a pick.
    @MainActor
    static func restoreRefusedDraft(
        _ text: String, _ images: [SelectedImage], draftKey: String, drafts: ComposerDrafts
    ) {
        let current = drafts.draft(draftKey)
        let merged = current.isEmpty ? text : text + " " + current
        drafts.setDraft(merged, key: draftKey)
        FreezeContext.shared.setDraftChars(merged.utf8.count)
        if !images.isEmpty {
            let restored = attach(images.map { .ok($0) }, to: drafts.images(draftKey))
            drafts.setImages(restored.images, key: draftKey)
        }
        AppLog.info("composer", "a refused send was returned to the draft", [
            "chars": "\(text.count)", "images": "\(images.count)", "key": draftKey,
        ])
    }

    /// The generic "it is back in the composer" line. Deliberately does not
    /// speculate about WHY: the owner supplies a specific sentence whenever it has
    /// one, and guessing here would sometimes be wrong.
    static let refusedNotice =
        "That message was not sent. It is back in the composer, ready to try again."

    /// Raise the library picker. Lowers the camera cover first — see the two
    /// flags' comment: they must never both be true.
    private func openPhotoPicker() {
        showCamera = false
        showPhotoPicker = true
    }

    /// Raise the camera, or explain why not. The permission question is asked
    /// HERE, once, from the pure rule; the picker owns the system prompt.
    private func openCamera() {
        switch Self.cameraTapOutcome(
            available: CameraPicker.isAvailable,
            authorization: AVCaptureDevice.authorizationStatus(for: .video)
        ) {
        case .present:
            cameraNotice = nil
            showPhotoPicker = false
            showCamera = true
        case .notice(let text):
            cameraNotice = text
        }
    }

    /// Decode + downscale + JPEG-encode picked items off the main actor, then
    /// merge into the selection. Surfaces a dismissible notice for images that are
    /// too large, over budget, or failed to decode.
    private func loadPicked(_ items: [PhotosPickerItem]) async {
        let outcome = await Self.loadUntilFull(items, onto: selectedImages) { item in
            await SelectedImage.load(from: item)
        }
        merge(outcome.loaded, notLoaded: outcome.notLoaded)
        pickerItems = []
    }

    /// Load picked items IN SELECTION ORDER, stopping once the selection is actually
    /// FULL, and report how many were never loaded.
    ///
    /// The bound is on the RESULT, not on the input, and that is the whole point. The
    /// first cut trimmed the input to the room available (`items.prefix(room)`) before
    /// it knew anything about the items, which threw away valid picks standing behind
    /// earlier failures: three attached plus [failed, failed, valid, valid] loaded only
    /// the two failures, kept three images, and told the user the two GOOD photos were
    /// "over the 5-image limit". An item that fails to decode, is too large, or does
    /// not fit the aggregate budget never took a slot, so the only honest stopping
    /// condition is "the selection is full", asked after each load.
    ///
    /// Fullness is asked of `attach` rather than re-derived here, for the reason
    /// `attach` exists at all: the ceiling and the budget have ONE implementation. It
    /// is a pure fold over at most five results, so asking it per item is free.
    ///
    /// Dropping the trim does not unbound the decode work, on either count a decode
    /// costs. The picker hands over at most `maxImages` items
    /// (`maxSelectionCount: Self.maxImages`), so this can never run more than five
    /// loads; it stops the moment the selection fills, so it never decodes a pick
    /// nothing could use; and it awaits each load in turn, so at most one ~12MP raster
    /// is alive at a time.
    ///
    /// Generic over the item, with the loader passed in, so the loop is assertable in
    /// the cheap tier: a `PhotosPickerItem` cannot be built in a unit test, and "never
    /// load what cannot be used" is a claim about this loop, not about the library.
    static func loadUntilFull<Item>(
        _ items: [Item],
        onto current: [SelectedImage],
        load: (Item) async -> SelectedImage.LoadResult
    ) async -> (loaded: [SelectedImage.LoadResult], notLoaded: Int) {
        var loaded: [SelectedImage.LoadResult] = []
        for (index, item) in items.enumerated() {
            if attach(loaded, to: current).images.count >= maxImages {
                return (loaded, items.count - index)
            }
            loaded.append(await load(item))
        }
        return (loaded, 0)
    }

    /// A camera shot, through the SAME preparation and the SAME merge a library
    /// pick gets: `SelectedImage.make(from: UIImage)` caps the raster at 1568px and
    /// encodes at 0.8 → 0.5, exactly as the Data path does, so a capture and a pick
    /// of the same photo produce the same attachment.
    ///
    /// Off the main actor for the encode (the note editor's capture path does the
    /// same): a full-resolution phone photo is a ~12MP raster and a JPEG encode of
    /// it on the main thread is a visible hitch right after the shutter.
    private func attachCaptured(_ image: UIImage) async {
        merge([await Self.prepareCapture(image)])
    }

    /// Encode a captured raster off the MainActor.
    static func prepareCapture(_ image: UIImage) async -> SelectedImage.LoadResult {
        await Task.detached(priority: .userInitiated) {
            SelectedImage.make(from: image)
        }.value
    }

    /// Fold freshly-loaded images into the draft's selection and show the notice.
    ///
    /// `notLoaded` is what the caller never decoded BECAUSE THE SELECTION WAS ALREADY
    /// FULL (`loadUntilFull` stops there); `attach` counts the ones it has to refuse
    /// itself, and the notice names the sum. Both are the ceiling refusing a pick, so
    /// both belong in the same sentence.
    private func merge(_ loaded: [SelectedImage.LoadResult], notLoaded: Int = 0) {
        let outcome = Self.attach(loaded, to: selectedImages, notLoaded: notLoaded)
        drafts.setImages(outcome.images, key: draftKey)
        // Only ever SET: an empty result must not silently wipe a notice the user
        // has not read yet (they dismiss it themselves).
        if let notice = outcome.notice { imageNotice = notice }
    }

    /// THE attachment rule, for every source: merge into `current` under the
    /// 5-image ceiling AND the aggregate base64 budget, and report what was
    /// skipped.
    ///
    /// A static pure function because it is the point where the library and the
    /// camera converge, and "the camera behaves exactly like a pick" is only true
    /// if there is literally one implementation of the limits. The aggregate budget
    /// is the one that is easy to lose: each image is individually capped at 10MB
    /// base64, so five of them can build ~50MB of concurrent base64 in the send
    /// path — enough to get the app jetsammed on a warm device. It is enforced at
    /// PICK/CAPTURE time so the user learns immediately instead of after composing
    /// a message that can never be sent.
    static func attach(
        _ loaded: [SelectedImage.LoadResult], to current: [SelectedImage],
        notLoaded: Int = 0
    ) -> (images: [SelectedImage], notice: String?) {
        var images = current
        var tooLarge = 0
        var failed = 0
        var overBudget = 0
        // Everything the CEILING refused: the picks the caller never decoded because
        // the selection was already full, plus whatever is left when the fifth slot
        // fills here. Both used to be silent, which made an over-cap pick
        // indistinguishable from a pick that never registered.
        //
        // Note what this loop deliberately does NOT do: a `.failed`, `.tooLarge`, or
        // over-budget result increments its own counter and takes NO slot, so a bad
        // pick can never cost a good one behind it its place. That is the rule
        // `loadUntilFull` leans on to decide when to stop loading.
        var noRoom = notLoaded
        var budgetUsed = current.reduce(0) { $0 + SelectedImage.base64Length($1.jpegData) }
        for (index, result) in loaded.enumerated() {
            guard images.count < maxImages else {
                noRoom += loaded.count - index
                break
            }
            switch result {
            case .ok(let image):
                let cost = SelectedImage.base64Length(image.jpegData)
                if budgetUsed + cost > SelectedImage.maxTotalBase64Length {
                    overBudget += 1
                } else {
                    budgetUsed += cost
                    images.append(image)
                }
            case .tooLarge: tooLarge += 1
            case .failed: failed += 1
            }
        }
        return (
            images,
            skippedNotice(
                tooLarge: tooLarge, overBudget: overBudget, failed: failed, noRoom: noRoom
            )
        )
    }

    /// The one "some images were skipped" sentence, or nil when nothing was.
    static func skippedNotice(
        tooLarge: Int, overBudget: Int, failed: Int, noRoom: Int = 0
    ) -> String? {
        var parts: [String] = []
        if noRoom > 0 { parts.append("\(noRoom) over the \(maxImages)-image limit") }
        if tooLarge > 0 { parts.append("\(tooLarge) too large to send") }
        if overBudget > 0 { parts.append("\(overBudget) over the total attachment size limit") }
        if failed > 0 { parts.append("\(failed) couldn't be read") }
        guard !parts.isEmpty else { return nil }
        return "Some images were skipped: \(parts.joined(separator: ", "))."
    }

    // MARK: - Voice Quick Action

    /// Can this transcript be auto-sent right now, or must it be parked in the
    /// draft, and why?
    ///
    /// A static pure function because getting it wrong LOSES THE USER'S WORDS, so
    /// it must be assertable without a hosted view or a store. The audio is
    /// already deleted by the time this runs (transcription succeeded, which is
    /// the one path that deletes), so this string is the only remaining copy: any
    /// route that neither sends nor drafts is data loss.
    ///
    /// A RUNNING TURN IS NO LONGER A DIVERSION. It used to be: the store refused a
    /// send while one was streaming and kept nothing, so the draft was the only
    /// place the transcript could go. The store now banks it instead
    /// (`ChatStore.SendOutcome.queued`), which is what the quick action promised
    /// all along, so the only remaining reasons to park a take are that nobody
    /// asked for a send, that there is nothing to say, or that the words cannot
    /// leave this device at all. A store that still refuses (its queue is full) is
    /// caught on the other side, by `voiceRescueReason`.
    static func voiceDeliveryRoute(
        autoSendArmed: Bool, offline: Bool, transcript: String
    ) -> VoiceDeliveryRoute {
        guard autoSendArmed else { return .draft(reason: "not-armed") }
        guard !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .draft(reason: "empty")
        }
        if offline { return .draft(reason: "offline") }
        return .send
    }

    enum VoiceDeliveryRoute: Equatable {
        case send
        case draft(reason: String)
    }

    /// Where a finished transcription goes. Normal mic taps compose into the
    /// draft (the user reviews and hits send); a quick-action take sends straight
    /// through, because "one action, then talk" is the whole point.
    ///
    /// Auto-send arming is consumed here, once.
    ///
    /// NO-LOSS, and EXACTLY ONCE. The audio is already gone (transcription
    /// succeeded), so this string is the only copy of what the user said, and it
    /// must land in exactly one of three places: the timeline (sent, or a retryable
    /// failed bubble that keeps the full text), the draft (any route
    /// `voiceDeliveryRoute` declines), or the draft because the store refused
    /// without keeping anything. "One of" is as load-bearing as "no loss" —
    /// see `voiceRescueReason` for the duplicate-send hazard on the other side.
    private func deliver(_ text: String) {
        // `takeAutoSend()` must be consulted exactly once and it SPENDS the
        // arming, so the route is computed from its answer rather than from the
        // flag (a second read would always say "not armed").
        let route = Self.voiceDeliveryRoute(
            autoSendArmed: quickAction.takeAutoSend(),
            offline: disabled, transcript: text
        )
        if case .draft(let reason) = route {
            if reason != "not-armed" {
                AppLog.info("voice", "quick action transcript held in draft", [
                    "reason": reason, "chars": "\(text.count)",
                ])
            }
            appendToDraft(text)
            return
        }
        let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        AppLog.info("voice", "quick action transcript auto-sent", ["chars": "\(trimmedText.count)"])
        FreezeContext.shared.note("voice-quick-send", trimmedText.utf8.count)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        Task { @MainActor in
            // The route is decided when the take STOPS; this reads the store's
            // answer when the send is actually attempted, and the two are seconds
            // apart. A turn starting in the gap is fine now (it banks the words);
            // a queue that filled up in the gap is not, and only this can see it.
            let reason = Self.voiceRescueReason(
                storeKeptTheWords: await onSend(trimmedText, [])
            )
            if let reason {
                AppLog.info("voice", "quick action transcript held in draft", [
                    "reason": reason, "chars": "\(trimmedText.count)",
                ])
                appendToDraft(trimmedText)
            }
        }
    }

    /// Does the composer still owe this transcript a home after asking the store to
    /// send it?
    ///
    /// THE TRAP, twice over. The first cut discarded `onSend`'s Bool entirely, so a
    /// refused send deleted the user's sentence (the audio is already gone by then).
    /// The second cut rescued on ANY false, which is worse in the common case: a
    /// real send failure (500, timeout, disconnect mid-send) has already kept the
    /// text as a retryable red bubble, so the same sentence then existed in the
    /// timeline AND the draft and could be sent twice. The manual `send()` path 100
    /// lines above says exactly this: "Failure keeps the text AND images as a failed
    /// bubble in the timeline (store's contract) — nothing restored here".
    ///
    /// So the question is not "did it succeed" but "did anything keep it", which is
    /// what `onSend` now answers (`ComposerView.sendKeepingWords`).
    static func voiceRescueReason(storeKeptTheWords: Bool) -> String? {
        storeKeptTheWords ? nil : "send-refused"
    }

    /// Why a pending quick action cannot open the mic right now, or nil for "go".
    ///
    /// A static pure function so the rule is testable without a hosted view, and
    /// so the answer is a REASON rather than a bare bool: each of these used to be
    /// an early `return` that logged nothing, which is what made "the shortcut did
    /// nothing" impossible to tell apart from "the shortcut was never delivered".
    ///
    ///  - `accepts`: session composers must not steal it (not a deferral — this
    ///    composer is simply not the consumer).
    ///  - `onScreen`: a retained off-screen tab must never open the mic.
    ///  - `recorderIdle`: a take is already running; do not restart it. This one
    ///    is a genuine WAIT, and `onChange(of: voice.state)` is what comes back.
    ///
    /// OFFLINE IS DELIBERATELY NOT A BLOCKER ANY MORE (the D1 fix). It was, on
    /// the reasoning that a quick action promises delivery to the agent and a
    /// draft is not that. The cost was the whole feature going silent whenever
    /// the phone was offline: the mic never opened, nothing was logged, and the
    /// words were never captured at all. Recording works offline, and the words
    /// are the irreplaceable part; whether they can be SENT is decided later, in
    /// `deliver`, when that answer is actually known.
    static func voiceQuickActionBlocker(
        accepts: Bool, onScreen: Bool, recorderIdle: Bool
    ) -> String? {
        if !accepts { return "not-a-consumer" }
        if !onScreen { return "off-screen" }
        if !recorderIdle { return "recorder-busy" }
        return nil
    }

    /// Open the mic for a pending Home-screen quick action.
    private func consumeVoiceQuickActionIfPending() {
        if let blocker = Self.voiceQuickActionBlocker(
            accepts: acceptsVoiceQuickAction, onScreen: onScreen,
            recorderIdle: voice.state == .idle
        ) {
            // Only when a request is actually waiting: this runs on every state
            // change, and logging the no-request case would drown the signal.
            if quickAction.pending != nil {
                AppLog.info("voice", "quick action deferred", [
                    "reason": blocker, "surface": draftKey,
                    "offline": disabled ? "true" : "false",
                ])
            }
            return
        }
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

    /// The shared one-line explanation row (offline, voice error, skipped images,
    /// camera denied).
    ///
    /// TWO LINES ONLY AT ORDINARY SIZES. `lineLimit(2)` is the right cap while a
    /// caption line fits ~40 characters, and it is a truncation machine once the user
    /// asks for accessibility text: at `accessibility-large` and up the 60-character
    /// camera sentence lost its ending and read "Camera access is off....", and the fix
    /// it names, "Settings", was the part that fell off, with ~44pt of the row still
    /// blank to the right of it. So the cap is lifted for accessibility sizes (the
    /// row grows downward, which the composer already handles: it measures itself and
    /// publishes the height), and the text gets `layoutPriority` over the spacer so
    /// the trailing dismiss button can never take width the sentence needs.
    /// `fixedSize(vertical:)` is what lets the wrapped lines claim their own height
    /// instead of being squeezed to one line's worth.
    private func noticeRow(_ text: String, icon: String, onDismiss: (() -> Void)? = nil) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(1)
            if let onDismiss {
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Image(systemName: Symbol.cancel)
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
    /// Which UIKit callback delivered the quick action that opened this mic
    /// (`launch`, `scene-connect`, `scene-perform`, `app-perform`, `debug-arg`),
    /// or nil for an ordinary mic tap.
    ///
    /// Published as the caption's accessibility VALUE, which makes it the one
    /// thing an XCUITest can assert about the delivery layer. Without it a UI
    /// test can only prove "a mic opened" — and a mic opening via a launch
    /// argument proves nothing about whether the real Home-screen path works,
    /// which is exactly the gap that let a warm-delivery regression ship.
    var deliverySource: String? = nil
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
                .accessibilityValue(deliverySource ?? "mic-button")
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
/// `busy` turns the trailing button into a STOP while a turn runs AND the
/// composer is empty; the moment anything is typed it is a send again, and that
/// send is banked by the store until the turn settles.
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
            busy: chat.sending || chat.streaming,
            // The two halves the old single `busy` flag conflated: a turn is
            // running (so the primary button offers STOP), and it is blocked on a
            // question (so this field is the answer and send wins).
            pendingQuestion: chat.pendingQuestion,
            onStop: { await chat.stopTurn() },
            disabled: !connection.online,
            disabledNotice: connection.online ? nil : "Offline — reconnecting…",
            // The send queue's ceiling. Nothing latches it: it is on screen while
            // the queue is full and gone as soon as one message goes out.
            ownerNotice: chat.queueFullNotice,
            // The store banks a send made mid-turn, so this composer's send button
            // stays live while a turn runs (see `ComposerPrimaryAction`).
            busyAcceptsSend: true,
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
            await Self.sendKeepingWords(chat, text, images)
        }
    }

    /// `onSend`'s Bool, answered honestly: "are these words safe with the store?"
    /// NOT "did the send succeed" — see `ComposerBar.voiceRescueReason` for why
    /// conflating the two duplicated a voice transcript into the draft AND the
    /// timeline.
    ///
    /// Two legs keep nothing and therefore answer false:
    ///  - the store refuses to hold the words at all
    ///    (`ChatStore.SendOutcome.refusedKeepingNothing`): it is torn down, or its
    ///    send queue is already at the ceiling. A turn merely being IN FLIGHT is no
    ///    longer one of these: the store banks the message and shows a queued
    ///    bubble, so a rescue there would put the same sentence in the timeline AND
    ///    the composer, where it could be sent twice.
    ///  - an ANSWER to a blocked structured question is not DELIVERED: the answer
    ///    endpoint has no optimistic bubble at all, so anything short of delivery
    ///    leaves the text nowhere. Note that this is stricter than "did it throw" —
    ///    a 409 (someone resolved the question elsewhere first) is a SUCCESS for the
    ///    question and a total loss for these words, and reading
    ///    `answerQuestion`'s Bool here dropped them silently.
    ///
    /// Everything else is safe by the store's own contract: past its acceptance
    /// guard every `return .failed` in `performSend` runs `markSendFailed` first,
    /// keeping the full text and its images as a retryable red bubble — which is
    /// why this deliberately does NOT read whether the POST succeeded.
    @MainActor
    static func sendKeepingWords(
        _ chat: ChatStore, _ text: String, _ images: [SelectedImage]
    ) async -> Bool {
        if chat.pendingQuestion, !text.isEmpty {
            return await chat.answerQuestionReportingOutcome(text) == .delivered
        }
        return await chat.sendReportingOutcome(text, images: images).keptTheWords
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
