import XCTest

/// The composer's `+` attachment menu, as a REAL tap opens it. The unit layer
/// (`ComposerCameraTests`) owns the rules; this owns the things no rule can assert:
/// that the rows are actually in the accessibility tree under the identifiers
/// automation taps, in the order they are supposed to be drawn in, and that a tap on
/// Take Photo really reaches the camera.
///
/// ⚠️ THE FOLKLORE THIS FILE CORRECTS: "a simulator has no camera, so the item is
/// hidden there". Measured on the iPhone 16 Pro simulator (iOS 26),
/// `UIImagePickerController.isSourceTypeAvailable(.camera)` answers **true** (see
/// the `[camera-probe]` line `ComposerCameraTests` prints), so the item is SHOWN
/// here and this test can assert it directly. The hidden branch is proven by the
/// pure rule instead, since no simulator on this machine reports a missing camera.
///
/// What still cannot be exercised anywhere but a device: the capture itself (the
/// shutter, retake, and the first real permission prompt).
final class ComposerAttachmentMenuUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    /// Pointed at the discard port, so this drives the real Chat tab without a
    /// single request reaching the server this simulator is paired to. The app
    /// stays PAIRED (the token is the Keychain's, the URL is the launch
    /// argument's), which is what puts `MainTabView` and its composer on screen at
    /// all — an unpaired launch renders `SetupView` and nothing else.
    private func launchOnChat() throws -> XCUIApplication {
        let app = UITestLaunch.launch()
        let plus = id("chat.plus", in: app)
        guard plus.waitForExistence(timeout: 60) else {
            throw XCTSkip(
                "no composer on screen — this simulator is not paired, so the app booted into SetupView"
            )
        }
        return app
    }

    /// Evidence a human can look at. Attached to the result bundle, and also written
    /// to the host's /tmp when that is reachable (the simulator resolves absolute
    /// paths on the host) so a report can point at a plain file.
    private func keepScreenshot(_ name: String) {
        let image = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? FileManager.default.createDirectory(
            atPath: "/tmp/ios-camera-fix", withIntermediateDirectories: true
        )
        let path = "/tmp/ios-camera-fix/\(name).png"
        try? image.pngRepresentation.write(to: URL(fileURLWithPath: path))
        print("[shot] \(FileManager.default.fileExists(atPath: path) ? path : "not writable from the test process")")
    }

    /// Both attachment sources are in the menu, under the ids automation taps, and
    /// PHOTOS IS ABOVE TAKE PHOTO. The order is the assertion that matters:
    /// `ComposerBar.plusMenuItems` is the spec, and this is the only place that can
    /// say the view really draws it (the rows are built by iterating that list).
    func testThePlusMenuOffersBothSourcesWithPhotosFirst() throws {
        let app = try launchOnChat()
        id("chat.plus", in: app).tap()

        let photo = id("chat.photo", in: app)
        XCTAssertTrue(photo.waitForExistence(timeout: 10),
                      "the `+` menu must still offer the photo library")
        let camera = id("chat.camera", in: app)
        XCTAssertTrue(camera.waitForExistence(timeout: 10),
                      "this device reports a camera, so the menu must offer Take Photo")
        XCTAssertEqual(camera.label, "Take Photo")
        XCTAssertTrue(camera.isHittable, "a visible item that cannot be tapped is worse than none")
        XCTAssertLessThan(
            photo.frame.minY, camera.frame.minY,
            "the two image sources read as a pair with the library first: photo \(photo.frame) camera \(camera.frame)"
        )
        keepScreenshot("plus-menu")
    }

    /// THE F1 REGRESSION. With the keyboard UP, tapping Take Photo used to present
    /// nothing: the `+` was a SwiftUI `Menu` (a UIKit context-menu interaction that
    /// reparents the button), and over the keyboard the tapped item's action was
    /// dropped entirely in 7 of 21 measured trials: the menu stayed painted where
    /// the composer had been and the `+` vanished from the control row. Nothing about
    /// the presentation could fix it, because the presentation code never ran. The
    /// `+` is a popover now, and this is the flow that has to keep working.
    ///
    /// The keyboard is up on purpose (that is the whole point) and the draft is left
    /// exactly as it was found: this simulator is also a dogfood device.
    func testTakePhotoPresentsTheCameraWithTheKeyboardUp() throws {
        let app = try launchOnChat()
        let field = id("chat.composer", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("kb")
        XCTAssertTrue(app.keyboards.element.waitForExistence(timeout: 10),
                      "this test is only meaningful with the keyboard up")
        let before = try XCTUnwrap(field.value as? String)

        id("chat.plus", in: app).tap()
        let camera = id("chat.camera", in: app)
        XCTAssertTrue(camera.waitForExistence(timeout: 10))
        camera.tap()

        // The system camera picker's own cancel button. Its presence is the picker
        // being on screen; nothing else in this app publishes that identifier.
        let dismiss = id("DismissImagePickerButton", in: app)
        XCTAssertTrue(
            dismiss.waitForExistence(timeout: 15),
            "Take Photo with the keyboard up must present the camera, not swallow the tap"
        )
        keepScreenshot("kbd-up-camera-presented")
        dismiss.tap()

        XCTAssertTrue(dismiss.waitForNonExistence(timeout: 15),
                      "the cover must really go away, not just report a cancel")

        // The composer is whole again. All three of F1's symptoms are checked here,
        // because the bug showed up as a set: the picker never came, the menu was left
        // painted where the composer had been, and the `+` was gone from the control row.
        let plus = id("chat.plus", in: app)
        XCTAssertTrue(plus.waitForExistence(timeout: 15),
                      "cancelling the camera must give the composer's `+` back")
        XCTAssertFalse(id("chat.camera", in: app).exists,
                       "the menu must not still be on screen after a row was chosen")
        let after = id("chat.composer", in: app)
        XCTAssertTrue(after.waitForExistence(timeout: 10))
        XCTAssertGreaterThan(
            plus.frame.minY, after.frame.maxY,
            "the `+` belongs in the control row under the field, not stranded where the "
            + "menu had reparented it: plus \(plus.frame) field \(after.frame)"
        )
        keepScreenshot("kbd-up-after-cancel")

        // Tappable, asserted BY TAPPING, at the button's own centre.
        //
        // Not `isHittable`, which is a harness reading and not an app fact here: with
        // the keyboard up this app has three overlapping full-screen windows (measured:
        // one of them reports `hittable=false`), and the `+` reads
        // `enabled=true, hittable=false` at frame (12, 489, 32, 32): BEFORE the camera
        // trip as well as after, at the identical frame, while the `tap()` on the line
        // above it went through and opened the menu. `XCUIElement.tap()` never consults
        // hittability, so a poll on `isHittable` measured the window stack and failed a
        // working app. maestro drives the same touch at the same point, online and
        // offline, and the menu reopens both times.
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: plus.frame.midX, dy: plus.frame.midY))
            .tap()
        XCTAssertTrue(id("chat.camera", in: app).waitForExistence(timeout: 10),
                      "a touch on the `+` must reopen the menu after a cancelled capture")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        XCTAssertEqual(id("chat.composer", in: app).value as? String, before,
                       "a cancelled capture must not touch the draft")
        after.tap()
        after.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: before.count + 8))
    }

    /// The menu must not cost the user their draft. Opening it and walking away is
    /// the cheapest version of the composer's standing rule (never clobber composed
    /// text).
    /// NOTE the baseline: the draft is read back AFTER typing rather than compared
    /// against the literal that was typed. `ComposerDrafts` is app-scoped and
    /// DURABLE by design, so a rerun starts with the previous run's text still in
    /// the field — asserting the literal failed against a working app once already
    /// ("keep my wordskeep my keep my wordswords"). The property under test is that
    /// the menu trip changes NOTHING, whatever was there.
    func testOpeningAndDismissingTheMenuKeepsTheDraft() throws {
        let app = try launchOnChat()
        let field = id("chat.composer", in: app)
        XCTAssertTrue(field.waitForExistence(timeout: 20))
        field.tap()
        field.typeText("keep")
        let before = try XCTUnwrap(field.value as? String)
        XCTAssertTrue(before.contains("keep"), "typing should have reached the draft, got \(before)")

        id("chat.plus", in: app).tap()
        XCTAssertTrue(id("chat.camera", in: app).waitForExistence(timeout: 10))
        // Dismiss without choosing: a tap outside the menu.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        let after = id("chat.composer", in: app)
        XCTAssertTrue(after.waitForExistence(timeout: 10), "the composer must come back")
        XCTAssertEqual(
            after.value as? String, before,
            "a trip through the attachment menu must not touch the draft"
        )

        // Leave the durable draft as this test found it — this simulator is also a
        // dogfood device, and an accumulating test string in the real composer is
        // litter (and what made the first version of this test flaky).
        after.tap()
        after.typeText(
            String(repeating: XCUIKeyboardKey.delete.rawValue, count: before.count + 8)
        )
    }
}
