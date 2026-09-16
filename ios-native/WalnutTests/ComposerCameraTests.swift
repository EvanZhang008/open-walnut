import XCTest
import UIKit
import ImageIO
import AVFoundation
@testable import Walnut

/// The composer's SECOND image source: `+` → Take Photo.
///
/// The user's report was "I can only pick a photo, I can't take one". The feature
/// is one menu item and one presented picker, so almost all of the risk is in the
/// three rules around it, and each one has a way of failing that a build still
/// looks fine with:
///
///  - the item must be ABSENT with no camera rather than disabled, and present
///    with one. Availability is a PARAMETER of the rule here because no machine
///    available reports both answers: the iPhone 16 Pro simulator (iOS 26) reports
///    a camera and really presents the picker, so a rule that asked UIKit for
///    itself would leave the hidden branch permanently untested.
///  - a DENIED permission must produce a sentence naming Settings. Presenting the
///    picker anyway shows a black frame, and the system prompt is asked exactly
///    once, so a user who tapped Don't Allow can otherwise never recover.
///  - a captured photo must go through the SAME preparation a library pick gets.
///    If the camera path grew its own encode, the bytes leaving the phone would
///    differ by source: the provider ceiling (2000px/dimension) and the 10MB
///    upload cap are enforced by that shared code, and a raw 12MP capture breaks
///    both.
///
/// What no test in this file can prove is the capture itself. The simulator
/// presents the picker but its viewfinder is a grey placeholder with nothing to
/// photograph, so the shutter, the retake screen, the orientation of a real
/// capture and the first permission prompt get their first real exercise on a
/// device.
///
/// `@MainActor` because `ComposerBar` is (it is a `View`), so its rules are
/// main-actor isolated — the same annotation `ComposerBottomRowTests` carries.
@MainActor
final class ComposerCameraTests: XCTestCase {

    // MARK: - The `+` menu's shape

    /// Take Photo sits DIRECTLY after Photos, so the two image sources read as a
    /// pair and the read-only host row stays last. Order is the whole assertion:
    /// the menu is the only place a user discovers the camera exists.
    func testTakePhotoFollowsThePhotoItemWhenACameraExists() {
        XCTAssertEqual(
            ComposerBar.plusMenuItems(cameraAvailable: true, hasHostProvenance: false),
            ["chat.photo", "chat.camera"]
        )
        XCTAssertEqual(
            ComposerBar.plusMenuItems(cameraAvailable: true, hasHostProvenance: true),
            ["chat.photo", "chat.camera", "composer.hostRow"],
            "the two attachment sources belong together, with the read-only provenance row last"
        )
    }

    /// No camera = no item, not a permanently disabled one: an item that can never
    /// do anything reads as a broken app. Only reachable through this parameter,
    /// since every device and simulator to hand reports a camera.
    func testNoCameraMeansNoTakePhotoItemAtAll() {
        let items = ComposerBar.plusMenuItems(cameraAvailable: false, hasHostProvenance: true)
        XCTAssertEqual(items, ["chat.photo", "composer.hostRow"])
        XCTAssertFalse(
            items.contains(ComposerBar.cameraItemID),
            "a camera-less device must not be offered a camera at all"
        )
    }

    /// `chat.photo` is a contract with automation that already taps it, and the two
    /// ids must stay distinguishable by a substring matcher (the lesson
    /// `TimelineHarnessIdentifierTests` records: an id contained in another makes a
    /// tap land wherever the search reaches first).
    func testTheTwoAttachmentIdentifiersKeepTheirNamesAndDoNotContainEachOther() {
        XCTAssertEqual(ComposerBar.photoItemID, "chat.photo")
        XCTAssertEqual(ComposerBar.cameraItemID, "chat.camera")
        XCTAssertFalse(ComposerBar.cameraItemID.contains(ComposerBar.photoItemID))
        XCTAssertFalse(ComposerBar.photoItemID.contains(ComposerBar.cameraItemID))
    }

    /// The shipped menu must agree with WHATEVER this machine reports, in either
    /// direction, and the measured value is printed so a report can quote it instead
    /// of assuming it. Deliberately not hardcoded to "a simulator has no camera":
    /// measured on the iPhone 16 Pro simulator (iOS 26),
    /// `UIImagePickerController.isSourceTypeAvailable(.camera)` answers TRUE, so an
    /// assertion built on the folklore fails against a working app — the exact
    /// class of false alarm `VoiceQuickActionUITests` records for SpringBoard
    /// labels.
    func testTheShippedMenuAgreesWithWhateverThisDeviceReports() {
        let available = CameraPicker.isAvailable
        print("[camera-probe] isSourceTypeAvailable(.camera) = \(available)")
        XCTAssertEqual(
            ComposerBar.plusMenuItems(cameraAvailable: available, hasHostProvenance: false)
                .contains(ComposerBar.cameraItemID),
            available,
            "the menu must offer Take Photo exactly when this device reports a camera"
        )
    }

    // MARK: - Permission

    /// The first tap must reach the picker, because presenting it is what raises the
    /// system prompt. Intercepting `.notDetermined` with our own alert would put the
    /// app between the tap and the OS for no gain.
    func testAnUndecidedPermissionPresentsThePickerSoTheSystemCanAsk() {
        XCTAssertEqual(
            ComposerBar.cameraTapOutcome(available: true, authorization: .notDetermined),
            .present
        )
    }

    func testGrantedPermissionPresentsThePicker() {
        XCTAssertEqual(
            ComposerBar.cameraTapOutcome(available: true, authorization: .authorized),
            .present
        )
    }

    /// The reported dead end, and the reason the notice has to name Settings: the
    /// prompt is asked once, so nothing in the app can ask again.
    func testDeniedAccessProducesTheSettingsNoticeInsteadOfABlackViewfinder() {
        XCTAssertEqual(
            ComposerBar.cameraTapOutcome(available: true, authorization: .denied),
            .notice(ComposerBar.cameraDeniedNotice)
        )
        XCTAssertTrue(
            ComposerBar.cameraDeniedNotice.contains("Settings"),
            "a permission notice that doesn't name the fix is a dead end: \(ComposerBar.cameraDeniedNotice)"
        )
        XCTAssertTrue(ComposerBar.cameraDeniedNotice.lowercased().contains("camera"))
    }

    /// Restricted (device management / Screen Time) is the same story from the user's
    /// side: the camera is off and Settings is where it lives.
    func testRestrictedAccessGetsTheSameSettingsNotice() {
        XCTAssertEqual(
            ComposerBar.cameraTapOutcome(available: true, authorization: .restricted),
            .notice(ComposerBar.cameraDeniedNotice)
        )
    }

    /// Unreachable through the UI (no camera ⇒ no item), and it must stay HONEST
    /// rather than borrow the permission sentence — telling a camera-less device to
    /// visit Settings sends the user somewhere with nothing to change.
    func testACameraLessTapWouldExplainTheHardwareNotThePermission() {
        XCTAssertEqual(
            ComposerBar.cameraTapOutcome(available: false, authorization: .authorized),
            .notice(ComposerBar.cameraUnavailableNotice)
        )
        XCTAssertFalse(ComposerBar.cameraUnavailableNotice.contains("Settings"))
    }

    // MARK: - A capture is prepared exactly like a pick

    /// THE parity assertion, driven through both real entry points: the camera's
    /// (`ComposerBar.prepareCapture`, which is what the picker's callback calls) and
    /// the library's (`SelectedImage.make(from: Data)`, which is what the
    /// PhotosPicker load calls). Same source photo in, same upload geometry and the
    /// same ceiling out.
    ///
    /// Square on purpose: both paths round independently (one through
    /// `kCGImageSourceThumbnailMaxPixelSize`, one through a renderer), so a square
    /// fixture makes "the same dimensions" an exact claim. The rectangular case
    /// below covers the aspect-preserving half.
    func testACapturedPhotoGetsTheSameUploadGeometryAsTheSameLibraryPhoto() async throws {
        let source = Self.fixture(width: 3000, height: 3000)
        let bytes = try XCTUnwrap(source.jpegData(compressionQuality: 1))

        let captured = try await unwrapOK(ComposerBar.prepareCapture(source))
        let picked = try unwrapOK(SelectedImage.make(from: bytes))

        let capturedSize = try XCTUnwrap(Self.pixelSize(of: captured.jpegData))
        let pickedSize = try XCTUnwrap(Self.pixelSize(of: picked.jpegData))
        XCTAssertEqual(capturedSize, pickedSize,
                       "a capture and a pick of the same photo must upload the same raster")
        // 1568px is the provider-safe longest edge; a raw capture is ~4000px and
        // would be rejected for a multi-image turn.
        XCTAssertEqual(max(capturedSize.width, capturedSize.height), 1568)

        XCTAssertEqual(captured.thumbnail.size, picked.thumbnail.size,
                       "the preview strip must not change size with the source")

        for image in [captured, picked] {
            XCTAssertLessThanOrEqual(
                SelectedImage.base64Length(image.jpegData),
                SelectedImage.maxUploadBase64Length,
                "both paths owe the same 10MB base64 upload ceiling"
            )
        }
    }

    /// The aspect-preserving half. Both paths cap the LONGEST edge at 1568 and keep
    /// the ratio; they round the short edge separately, so it is asserted within a
    /// pixel rather than pretended to be identical.
    func testANonSquareCaptureKeepsTheSameLongestEdgeAndAspectAsAPick() async throws {
        let source = Self.fixture(width: 3000, height: 2000)
        let bytes = try XCTUnwrap(source.jpegData(compressionQuality: 1))

        let captured = try await unwrapOK(ComposerBar.prepareCapture(source))
        let picked = try unwrapOK(SelectedImage.make(from: bytes))
        let capturedSize = try XCTUnwrap(Self.pixelSize(of: captured.jpegData))
        let pickedSize = try XCTUnwrap(Self.pixelSize(of: picked.jpegData))

        XCTAssertEqual(capturedSize.width, 1568)
        XCTAssertEqual(pickedSize.width, 1568)
        XCTAssertLessThanOrEqual(abs(capturedSize.height - pickedSize.height), 1,
                                 "captured \(capturedSize) vs picked \(pickedSize)")
    }

    // MARK: - …and merged by exactly the same rules

    /// A capture lands in the selection through the shared merge, so the strip and
    /// the send payload cannot tell it apart from a pick.
    func testACapturedPhotoJoinsTheSelectionWithNoNotice() async throws {
        let captured = try await unwrapOK(
            ComposerBar.prepareCapture(Self.fixture(width: 800, height: 600))
        )
        let outcome = ComposerBar.attach([.ok(captured)], to: [])
        XCTAssertEqual(outcome.images.count, 1)
        XCTAssertNil(outcome.notice, "a good photo must not produce a warning")
    }

    /// The count ceiling is the shared rule, so a capture at five images is refused
    /// the same way a sixth pick is — never silently appended past the cap.
    func testACaptureCannotPushTheSelectionPastTheImageCeiling() async throws {
        let full = (0..<ComposerBar.maxImages).map { _ in Self.stub(bytes: 1_000) }
        let captured = try await unwrapOK(
            ComposerBar.prepareCapture(Self.fixture(width: 400, height: 400))
        )
        let outcome = ComposerBar.attach([.ok(captured)], to: full)
        XCTAssertEqual(outcome.images.count, ComposerBar.maxImages)
    }

    /// The "too large" and "over the total size limit" notices are the SAME
    /// sentences both sources produce — the point of merging through one function.
    func testTheSkippedNoticeIsSharedByBothSources() {
        let tooLarge = ComposerBar.attach([.tooLarge], to: [])
        XCTAssertEqual(tooLarge.images.count, 0)
        XCTAssertEqual(
            tooLarge.notice, "Some images were skipped: 1 too large to send."
        )

        // 8MB already attached (≈10.7MB base64) + an 11MB capture (≈14.7MB) is over
        // the 24MB aggregate, which is the cap that keeps the send path from
        // materialising ~50MB of base64 at once.
        let overBudget = ComposerBar.attach(
            [.ok(Self.stub(bytes: 11_000_000))], to: [Self.stub(bytes: 8_000_000)]
        )
        XCTAssertEqual(overBudget.images.count, 1, "the already-attached image stays")
        XCTAssertEqual(
            overBudget.notice,
            "Some images were skipped: 1 over the total attachment size limit."
        )

        XCTAssertNil(
            ComposerBar.skippedNotice(tooLarge: 0, overBudget: 0, failed: 0),
            "nothing skipped means no row at all"
        )
        XCTAssertEqual(
            ComposerBar.skippedNotice(tooLarge: 1, overBudget: 2, failed: 3),
            "Some images were skipped: 1 too large to send, 2 over the total attachment size limit, 3 couldn't be read."
        )
    }

    /// An unreadable capture (the picker handed back something that would not
    /// encode) reports the same "couldn't be read" line a broken library item does,
    /// and leaves the existing selection alone.
    func testAnUnreadableCaptureLeavesTheSelectionUntouched() {
        let existing = [Self.stub(bytes: 2_000)]
        let outcome = ComposerBar.attach([.failed], to: existing)
        XCTAssertEqual(outcome.images.count, 1)
        XCTAssertEqual(outcome.notice, "Some images were skipped: 1 couldn't be read.")
    }

    // MARK: - Every icon resolves

    /// A misspelled SF Symbol does not throw, warn, or draw a placeholder: it draws
    /// a 0pt blank. This shipped as `camera.slash`, which does NOT exist (the only
    /// slashed camera in the catalog is `camera.macro.slash`), so the denied notice
    /// rendered its sentence against the margin with an invisible icon in front of
    /// it — caught by looking at a screenshot, which is not a gate. Now it is one,
    /// for every symbol the composer names.
    func testEverySymbolTheComposerNamesResolves() {
        for name in ComposerBar.Symbol.all {
            XCTAssertNotNil(
                UIImage(systemName: name),
                "`\(name)` is not an SF Symbol on this OS, so it renders as a blank 0pt glyph"
            )
        }
        XCTAssertTrue(ComposerBar.Symbol.all.contains(ComposerBar.Symbol.camera))
        XCTAssertTrue(ComposerBar.Symbol.all.contains(ComposerBar.Symbol.cameraDeniedNotice))
    }

    // MARK: - The wiring between the rules and the view

    /// Read the view as TEXT (the `TimelineHarnessIdentifierTests` pattern): these
    /// literals are what turn every rule above into a control on screen, and a rule
    /// wired to nothing passes all day. `ComposerAttachmentMenuUITests` proves the
    /// rows by tapping, which is stronger — but it is a separate, slower target, and
    /// it cannot see the DENIED notice at all (that needs the camera permission
    /// revoked out of band). This keeps both in the cheap tier.
    ///
    /// The FIRST two fragments are the ones a review finding forced: `plusMenuItems`
    /// and `Symbol` used to be specs nothing drew, so the tests above and below them
    /// pinned nothing the app does. The view now iterates that list to build its rows
    /// and names every icon through that enum.
    func testTheViewBuildsItsRowsFromTheRulesThisFileTests() throws {
        let source = try Self.composerCode()
        for fragment in [
            "let items = Self.plusMenuItems(",
            "ForEach(Array(items.enumerated()), id: \\.element)",
            "case Self.photoItemID:",
            "case Self.cameraItemID:",
            "case Self.hostRowItemID:",
            "Self.attachmentSourceLabel(\"Photos\", attached: selectedImages.count)",
            "Self.attachmentSourceLabel(\"Take Photo\", attached: selectedImages.count)",
            "icon: Symbol.camera",
            "action: openCamera",
            "noticeRow(cameraNotice, icon: Symbol.cameraDeniedNotice)",
            "Self.loadUntilFull(items, onto: selectedImages)",
        ] {
            XCTAssertTrue(
                source.contains(fragment),
                "ComposerView.swift no longer contains `\(fragment)` — the camera row or its notice is not wired to the rules this file tests"
            )
        }
        // The `+` must NOT be a SwiftUI `Menu` any more: over the keyboard a context
        // menu dropped the tapped item's action outright (7 of 21 trials), which is
        // the F1 defect. See `plusButton`'s comment for the measurement.
        XCTAssertFalse(
            source.contains("Menu {"),
            "the `+` is a popover, not a Menu: a context menu over the keyboard swallows the item's action"
        )
        // The picked items must NOT be trimmed by the room available before anything is
        // known about them: that is what let a failure take a later valid pick's slot.
        // The pure tests above can all pass with the trim back in place, because the
        // trim lives in the view. Checked against `composerCode()`, not the raw file:
        // `plusButton`'s doc comment quotes this very expression as the defect it
        // describes.
        XCTAssertFalse(
            source.contains("items.prefix("),
            "the loader stops when the SELECTION is full, never by trimming the input: a "
            + "pick that fails to decode takes no slot, so it must not cost a later pick one"
        )
        XCTAssertTrue(source.contains(".popover(isPresented: $showAttachmentMenu"))
        XCTAssertTrue(
            source.contains(".presentationCompactAdaptation(.popover)"),
            "without this the popover adapts to a full sheet on a phone"
        )
    }

    // MARK: - Both sources name the ceiling

    /// At the ceiling both rows are disabled, so both have to SAY why. Take Photo
    /// shipped greyed and silent next to a "Photos (5/5)" that explained itself.
    func testBothSourceRowsNameTheCountOnceSomethingIsAttached() {
        XCTAssertEqual(ComposerBar.attachmentSourceLabel("Photos", attached: 0), "Photos")
        XCTAssertEqual(
            ComposerBar.attachmentSourceLabel("Take Photo", attached: 0), "Take Photo",
            "an empty selection has no count to report, so the row stays plain"
        )
        XCTAssertEqual(
            ComposerBar.attachmentSourceLabel("Take Photo", attached: 3), "Take Photo (3/5)"
        )
        XCTAssertEqual(
            ComposerBar.attachmentSourceLabel("Take Photo", attached: ComposerBar.maxImages),
            "Take Photo (5/5)",
            "the disabled row at the ceiling must read the same way the library row does"
        )
        XCTAssertEqual(
            ComposerBar.attachmentSourceLabel("Photos", attached: ComposerBar.maxImages),
            "Photos (5/5)"
        )
    }

    // MARK: - The popover has to fit its own words

    /// Ordinary sizes keep the shipped geometry exactly. Every screenshot of this menu
    /// was taken at 260pt and none of them should change.
    func testTheMenuKeepsItsShippedWidthAtOrdinarySizes() {
        for width in [320.0, 375.0, 390.0, 402.0, 430.0] as [CGFloat] {
            XCTAssertEqual(
                ComposerBar.attachmentMenuWidth(isAccessibilitySize: false, availableWidth: width),
                260,
                "an ordinary text size must not move the menu's width on a \(width)pt screen"
            )
        }
    }

    /// At accessibility sizes the popover takes the window's width less a margin per
    /// side, computed per device. A constant that fits the 402pt phone the fix was
    /// verified on would be clipped on a narrower one.
    func testTheMenuWidensToTheScreenAtAccessibilitySizes() {
        let expected: [CGFloat: CGFloat] = [402: 370, 390: 358, 375: 343, 320: 288, 430: 398]
        for (screen, width) in expected {
            XCTAssertEqual(
                ComposerBar.attachmentMenuWidth(isAccessibilitySize: true, availableWidth: screen),
                width,
                "a \(screen)pt screen leaves \(width)pt for the menu"
            )
        }
    }

    /// The property that matters on every device, stated as a property rather than as a
    /// table: the menu plus both margins never exceeds the screen it is drawn on, at
    /// either text size.
    func testTheMenuNeverExceedsTheScreenItIsShownOn() {
        for screen in stride(from: 320.0, through: 440.0, by: 1.0) {
            for accessibility in [false, true] {
                let width = ComposerBar.attachmentMenuWidth(
                    isAccessibilitySize: accessibility, availableWidth: CGFloat(screen)
                )
                XCTAssertLessThanOrEqual(
                    width + 2 * ComposerBar.attachmentMenuSideMargin, CGFloat(screen),
                    "a \(width)pt menu is wider than a \(screen)pt screen can hold "
                    + "(accessibility: \(accessibility))"
                )
                XCTAssertGreaterThanOrEqual(width, ComposerBar.minAttachmentMenuWidth)
            }
        }
    }

    /// Before the first layout, and during the zero-sized snapshot pass a backgrounding
    /// triggers, there is no measurement. That must read as "use what has always
    /// shipped", never as "collapse to the floor".
    func testAnUnmeasuredWidthFallsBackToTheShippedWidth() {
        for accessibility in [false, true] {
            XCTAssertEqual(
                ComposerBar.attachmentMenuWidth(
                    isAccessibilitySize: accessibility, availableWidth: 0
                ),
                ComposerBar.defaultAttachmentMenuWidth
            )
        }
        XCTAssertEqual(
            ComposerBar.attachmentMenuWidth(isAccessibilitySize: true, availableWidth: -100),
            ComposerBar.defaultAttachmentMenuWidth,
            "a nonsense measurement is still not a reason to resize the menu"
        )
    }

    /// The width rule and the wrapping are ONE fix, and the view has to use both: a
    /// wider popover still truncates if the row keeps a line limit, and a wrapping row
    /// still looks cramped at 260pt. Read as text, because a `.lineLimit` is not
    /// observable from a unit test any other way.
    func testTheSourceRowsWrapTheirVisibleTextInsteadOfTruncating() throws {
        let dense = try Self.composerCode()
            .components(separatedBy: .whitespacesAndNewlines).joined()
        XCTAssertTrue(
            dense.contains(
                "Text(title).lineLimit(nil).multilineTextAlignment(.leading)"
                + ".fixedSize(horizontal:false,vertical:true)"
            ),
            "the row's VISIBLE text must wrap without a line limit: the accessibility "
            + "label was always complete, so only the pixels ever truncated"
        )
        XCTAssertTrue(
            dense.contains(".frame(width:Self.attachmentMenuWidth("),
            "the popover must take its width from the rule this file tests, not a literal"
        )
        XCTAssertFalse(
            dense.contains(".frame(width:260)"),
            "260 belongs in `defaultAttachmentMenuWidth`, where the accessibility case "
            + "can be reasoned about next to it"
        )
    }

    // MARK: - Nothing is dropped in silence

    /// THE F4 REGRESSION, through the real path: with three attached, picking four more
    /// produced five images and NO notice, so the two the app threw away looked like a
    /// pick that never happened. Both halves of the ceiling now report: the picks the
    /// loader never decoded because the selection filled (`notLoaded`) and whatever the
    /// merge itself has no room for.
    ///
    /// Also the on-screen case: this is the "2 over the 5-image limit" line the
    /// verification screenshot shows.
    func testOverCapLibraryPicksAreCountedAndNamed() async {
        let existing = (0..<3).map { _ in Self.stub(bytes: 1_000) }
        let picks: [SelectedImage.LoadResult] = (0..<4).map { .ok(Self.stub(bytes: 1_000 + $0)) }
        let counter = LoadCounter()
        let outcome = await ComposerBar.loadUntilFull(picks, onto: existing) { pick in
            counter.count += 1
            return pick
        }
        XCTAssertEqual(
            counter.count, 2,
            "two slots were free, so nothing past them is worth a decode"
        )
        XCTAssertEqual(outcome.notLoaded, 2)
        let attached = ComposerBar.attach(
            outcome.loaded, to: existing, notLoaded: outcome.notLoaded
        )
        XCTAssertEqual(attached.images.count, ComposerBar.maxImages)
        XCTAssertEqual(
            attached.notice, "Some images were skipped: 2 over the 5-image limit.",
            "an over-cap pick has to say so: silence reads as a pick that did not register"
        )
    }

    // MARK: - A bad pick never costs a good pick its slot

    /// THE MIXED-PICK BUG. Trimming the INPUT to the room available decided which picks
    /// mattered before it knew anything about them, so a failure standing in front of a
    /// valid pick took that pick's slot: three attached plus [failed, failed, valid,
    /// valid] loaded only the two failures, kept three images, and reported the two GOOD
    /// photos as "over the 5-image limit". Correct is five images and a sentence about
    /// two unreadable files, with nothing over the limit.
    func testAFailedPickDoesNotCostTheValidPickBehindItItsSlot() async {
        let existing = (0..<3).map { _ in Self.stub(bytes: 1_000) }
        let first = Self.stub(bytes: 1_100)
        let second = Self.stub(bytes: 1_200)
        let picks: [SelectedImage.LoadResult] = [.failed, .failed, .ok(first), .ok(second)]
        let counter = LoadCounter()
        let outcome = await ComposerBar.loadUntilFull(picks, onto: existing) { pick in
            counter.count += 1
            return pick
        }
        XCTAssertEqual(
            counter.count, 4,
            "a failure takes no slot, so every pick behind one still has to be tried"
        )
        XCTAssertEqual(outcome.notLoaded, 0)
        let attached = ComposerBar.attach(
            outcome.loaded, to: existing, notLoaded: outcome.notLoaded
        )
        XCTAssertEqual(attached.images.count, ComposerBar.maxImages)
        XCTAssertEqual(
            attached.images.suffix(2).map(\.jpegData), [first.jpegData, second.jpegData],
            "and they land in selection order"
        )
        XCTAssertEqual(
            attached.notice, "Some images were skipped: 2 couldn't be read.",
            "nothing was over the limit here: two files simply could not be decoded"
        )
    }

    /// The same for a too-large pick, and the case where BOTH reasons are true at once:
    /// three attached plus [tooLarge, valid, valid, valid] fills the two free slots with
    /// the first two valid picks, never decodes the fourth (nothing could use it), and
    /// names both refusals in one sentence, ceiling first.
    func testATooLargePickDoesNotHideTheValidPicksBehindIt() async {
        let existing = (0..<3).map { _ in Self.stub(bytes: 1_000) }
        let first = Self.stub(bytes: 1_100)
        let second = Self.stub(bytes: 1_200)
        let third = Self.stub(bytes: 1_300)
        let picks: [SelectedImage.LoadResult] = [
            .tooLarge, .ok(first), .ok(second), .ok(third),
        ]
        let counter = LoadCounter()
        let outcome = await ComposerBar.loadUntilFull(picks, onto: existing) { pick in
            counter.count += 1
            return pick
        }
        XCTAssertEqual(counter.count, 3, "the fourth pick had no slot left to land in")
        XCTAssertEqual(outcome.notLoaded, 1)
        let attached = ComposerBar.attach(
            outcome.loaded, to: existing, notLoaded: outcome.notLoaded
        )
        XCTAssertEqual(attached.images.count, ComposerBar.maxImages)
        XCTAssertEqual(
            attached.images.suffix(2).map(\.jpegData), [first.jpegData, second.jpegData]
        )
        XCTAssertEqual(
            attached.notice,
            "Some images were skipped: 1 over the 5-image limit, 1 too large to send."
        )
    }

    /// An over-budget pick takes no slot either, so the pick behind it still lands: four
    /// attached plus [over-budget, valid] is five images and one over-budget line, with
    /// nothing over the image limit.
    func testAnOverBudgetPickDoesNotTakeASlotFromThePickBehindIt() async {
        let existing = (0..<4).map { _ in Self.stub(bytes: 1_000) }
        // One pick that on its own blows the aggregate base64 budget.
        let huge = Self.stub(bytes: SelectedImage.maxTotalBase64Length)
        // A distinct size, so "the last slot holds THIS pick" is an assertion and not a
        // coincidence of every stub being the same length.
        let small = Self.stub(bytes: 1_234)
        let picks: [SelectedImage.LoadResult] = [.ok(huge), .ok(small)]
        let counter = LoadCounter()
        let outcome = await ComposerBar.loadUntilFull(picks, onto: existing) { pick in
            counter.count += 1
            return pick
        }
        XCTAssertEqual(counter.count, 2, "the refused pick left the last slot open")
        XCTAssertEqual(outcome.notLoaded, 0)
        let attached = ComposerBar.attach(
            outcome.loaded, to: existing, notLoaded: outcome.notLoaded
        )
        XCTAssertEqual(attached.images.count, ComposerBar.maxImages)
        XCTAssertEqual(attached.images.last?.jpegData, small.jpegData)
        XCTAssertEqual(
            attached.notice,
            "Some images were skipped: 1 over the total attachment size limit.",
            "the ceiling refused nothing here, the budget did"
        )
    }

    /// A pick onto a FULL selection decodes nothing at all and still says why. Not
    /// reachable from the UI (both source rows are disabled at the ceiling), but it is
    /// the rule, and it is the property that lets the trim go away without the decode
    /// work growing.
    func testAPickOntoAFullSelectionDecodesNothing() async {
        let full = (0..<ComposerBar.maxImages).map { _ in Self.stub(bytes: 1_000) }
        let picks: [SelectedImage.LoadResult] = [.ok(Self.stub(bytes: 1_000))]
        let counter = LoadCounter()
        let outcome = await ComposerBar.loadUntilFull(picks, onto: full) { pick in
            counter.count += 1
            return pick
        }
        XCTAssertEqual(counter.count, 0)
        XCTAssertEqual(outcome.loaded.count, 0)
        XCTAssertEqual(outcome.notLoaded, 1)
        let attached = ComposerBar.attach(outcome.loaded, to: full, notLoaded: outcome.notLoaded)
        XCTAssertEqual(attached.images.count, ComposerBar.maxImages)
        XCTAssertEqual(attached.notice, "Some images were skipped: 1 over the 5-image limit.")
    }

    /// The other half of the ceiling: results the merge itself cannot take, counted
    /// where the loop breaks rather than dropped off the end of it.
    func testResultsRefusedByTheCeilingAreCounted() {
        let existing = (0..<4).map { _ in Self.stub(bytes: 1_000) }
        let outcome = ComposerBar.attach(
            [.ok(Self.stub(bytes: 1_000)), .ok(Self.stub(bytes: 1_000)), .ok(Self.stub(bytes: 1_000))],
            to: existing
        )
        XCTAssertEqual(outcome.images.count, ComposerBar.maxImages)
        XCTAssertEqual(outcome.notice, "Some images were skipped: 2 over the 5-image limit.")
    }

    /// A capture at the ceiling is the camera's version of the same sentence, which is
    /// the point of merging both sources through one function.
    func testACaptureRefusedByTheCeilingSaysSoToo() async throws {
        let full = (0..<ComposerBar.maxImages).map { _ in Self.stub(bytes: 1_000) }
        let captured = try await unwrapOK(
            ComposerBar.prepareCapture(Self.fixture(width: 400, height: 400))
        )
        let outcome = ComposerBar.attach([.ok(captured)], to: full)
        XCTAssertEqual(outcome.images.count, ComposerBar.maxImages)
        XCTAssertEqual(outcome.notice, "Some images were skipped: 1 over the 5-image limit.")
    }

    /// The ceiling's reason reads first, then the rest, and nothing skipped is still
    /// no row at all.
    func testTheSkippedNoticeListsEveryReason() {
        XCTAssertNil(ComposerBar.skippedNotice(tooLarge: 0, overBudget: 0, failed: 0, noRoom: 0))
        XCTAssertEqual(
            ComposerBar.skippedNotice(tooLarge: 1, overBudget: 2, failed: 3, noRoom: 4),
            "Some images were skipped: 4 over the 5-image limit, 1 too large to send, 2 over the total attachment size limit, 3 couldn't be read."
        )
    }

    /// The two presentations are separate flags, and raising one must lower the
    /// other: a `.photosPicker` and a `.fullScreenCover` presented together is a
    /// UIKit conflict where one silently loses.
    func testTheTwoPickerFlagsAreMutuallyExclusiveInTheView() throws {
        // Whitespace-stripped: the property is the ORDER of two assignments, not
        // how the file happens to be indented.
        let dense = try Self.composerSource()
            .components(separatedBy: .whitespacesAndNewlines).joined()
        XCTAssertTrue(
            dense.contains("funcopenPhotoPicker(){showCamera=falseshowPhotoPicker=true}"),
            "opening the library must lower the camera flag first"
        )
        XCTAssertTrue(
            dense.contains("showPhotoPicker=falseshowCamera=true"),
            "opening the camera must lower the photo-picker flag first"
        )
    }

    // MARK: - Helpers

    /// The view's CODE: the same file with comment-only lines dropped.
    ///
    /// Every wiring assertion is a text search, and text cannot tell code from prose
    /// about code. Both errors are real and one of them shipped: `plusButton`'s doc
    /// comment quotes `items.prefix(room)` as the defect it describes, so searching the
    /// raw file failed a view that no longer trims anything; the mirror-image error is a
    /// fragment counted as "wired" because somebody merely wrote about it.
    ///
    /// LEADING `//` only. Stripping trailing comments would mean reasoning about `//`
    /// inside string literals, and no assertion here needs that.
    private static func composerCode() throws -> String {
        try composerSource()
            .split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
            .joined(separator: "\n")
    }

    private static func composerSource() throws -> String {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // WalnutTests/
            .deletingLastPathComponent()   // ios-native/
        return try String(
            contentsOf: root.appendingPathComponent("Walnut/Views/Chat/ComposerView.swift"),
            encoding: .utf8
        )
    }

    /// A deterministic photo-shaped raster at scale 1, so points == pixels and both
    /// downscale paths see the same source dimensions. Patterned rather than flat:
    /// a solid colour encodes to a few hundred bytes and would make the size
    /// assertions vacuous.
    private static func fixture(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let size = CGSize(width: width, height: height)
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            let step = 24
            for y in stride(from: 0, to: height, by: step) {
                for x in stride(from: 0, to: width, by: step) {
                    UIColor(
                        hue: CGFloat((x / step + y / step) % 64) / 64,
                        saturation: 0.9, brightness: 0.85, alpha: 1
                    ).setFill()
                    context.fill(CGRect(x: x, y: y, width: step / 2, height: step))
                }
            }
        }
    }

    /// A SelectedImage of a known payload size, for the ceiling arithmetic. The
    /// thumbnail is irrelevant to `attach`, which only reads `jpegData`.
    private static func stub(bytes: Int) -> SelectedImage {
        SelectedImage(jpegData: Data(count: bytes), thumbnail: UIImage())
    }

    /// Counts how many times a loader was asked for bytes. A reference type rather than
    /// a captured `var` so the closure stays legal whatever concurrency mode this target
    /// is built in, and so "it never decoded that pick" is an assertion rather than a
    /// claim: it is the only observable difference between loading lazily and loading
    /// everything the picker handed over.
    private final class LoadCounter {
        var count = 0
    }

    private static func pixelSize(of data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
        else { return nil }
        return CGSize(width: width.doubleValue, height: height.doubleValue)
    }

    private func unwrapOK(
        _ result: SelectedImage.LoadResult, file: StaticString = #filePath, line: UInt = #line
    ) throws -> SelectedImage {
        guard case .ok(let image) = result else {
            XCTFail("expected a prepared image, got \(result)", file: file, line: line)
            throw XCTSkip("no image to compare")
        }
        return image
    }
}
