import XCTest

/// The composer's own camera (`camera_capture`), driven on the DEBUG
/// `-camera-harness` (CameraHarnessView) with the fake camera: a drawn
/// whiteboard and a generated video, so nothing opens a camera or a microphone.
/// What is taken goes straight into the message (no look first, no Send in the
/// camera). Each state is attached as a screenshot: Photo, a photo added,
/// recording with its Photo button, and the video added.
final class CameraCaptureUITests: XCTestCase {

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func id(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == %@", identifier)).firstMatch
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Waits for an element's label to read `label`.
    private func waitFor(_ element: XCUIElement, label: String, timeout: TimeInterval) {
        let reads = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [reads], timeout: timeout), .completed,
                       "\(element.identifier) read \"\(element.label)\", not \"\(label)\"")
    }

    func testPhotosAndAVideoGoStraightIntoTheMessage() {
        let app = UITestLaunch.launch(["-camera-harness"])
        let shutter = id("camera.shutter", in: app)
        XCTAssertTrue(shutter.waitForExistence(timeout: 30))
        XCTAssertTrue(id("camera.on", in: app).exists, "Camera on shows while the picture is live")
        XCTAssertFalse(id("camera.added", in: app).exists, "nothing added yet")
        shot("camera-photo", app)

        // A photo: added the moment it is taken; the camera stays open.
        shutter.tap()
        let added = id("camera.added", in: app)
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        waitFor(added, label: "1 photo added", timeout: 5)
        XCTAssertTrue(shutter.exists, "the camera stays open for the next one")
        shot("camera-photo-added", app)

        // A video, with a photo taken while it records.
        id("camera.mode.video", in: app).tap()
        XCTAssertTrue(id("camera.soundToggle", in: app).waitForExistence(timeout: 5))
        shutter.tap()
        let still = id("camera.stillDuringRecording", in: app)
        XCTAssertTrue(still.waitForExistence(timeout: 10))
        XCTAssertTrue(id("camera.timer", in: app).exists)
        still.tap()
        waitFor(added, label: "2 photos added", timeout: 5)
        sleep(3)
        shot("camera-recording", app)
        shutter.tap()

        // The video goes in by itself once it is made; never sent from here.
        waitFor(added, label: "2 photos and 1 video added", timeout: 30)
        XCTAssertTrue(shutter.waitForExistence(timeout: 10), "back to the picture for the next one")
        XCTAssertFalse(id("camera.held", in: app).exists, "nothing is held")
        shot("camera-video-added", app)

        // The person closes the camera and sends with the composer's own Send.
        id("camera.close", in: app).tap()
        let harness = id("camera.harness.added", in: app)
        XCTAssertTrue(harness.waitForExistence(timeout: 10))
        XCTAssertEqual(harness.label, "photos=2 clips=1 stills=true")
    }
}
