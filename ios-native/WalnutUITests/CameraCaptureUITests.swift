import XCTest

/// The composer's own camera (`camera_capture`), driven on the DEBUG
/// `-camera-harness` (CameraHarnessView) with the fake camera: a drawn
/// whiteboard and a generated video, so nothing opens a camera or a microphone.
/// Each state is attached as a screenshot: Photo, recording with its Photo
/// button, and the look after a video.
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

    func testPhotoRecordingAndTheLookAfter() {
        let app = UITestLaunch.launch(["-camera-harness"])
        let shutter = id("camera.shutter", in: app)
        XCTAssertTrue(shutter.waitForExistence(timeout: 30))
        XCTAssertTrue(id("camera.on", in: app).exists, "Camera on shows while the picture is live")
        shot("camera-photo", app)

        // A photo: looked at, then added; the camera stays open.
        shutter.tap()
        let addAnother = id("camera.addAnother", in: app)
        XCTAssertTrue(addAnother.waitForExistence(timeout: 10))
        shot("camera-photo-preview", app)
        addAnother.tap()
        XCTAssertTrue(shutter.waitForExistence(timeout: 10))

        // A video, with a photo taken while it records.
        id("camera.mode.video", in: app).tap()
        XCTAssertTrue(id("camera.soundToggle", in: app).waitForExistence(timeout: 5))
        shutter.tap()
        let still = id("camera.stillDuringRecording", in: app)
        XCTAssertTrue(still.waitForExistence(timeout: 10))
        XCTAssertTrue(id("camera.timer", in: app).exists)
        still.tap()
        XCTAssertTrue(id("camera.notice", in: app).waitForExistence(timeout: 5), "the photo says it was added")
        sleep(3)
        shot("camera-recording", app)
        shutter.tap()

        // The look after: never sent by itself.
        let send = id("camera.send", in: app)
        XCTAssertTrue(send.waitForExistence(timeout: 30))
        let caption = id("camera.clipCaption", in: app)
        XCTAssertTrue(caption.waitForExistence(timeout: 30))
        XCTAssertTrue(caption.label.contains("still"), "caption was \(caption.label)")
        shot("camera-video-preview", app)
        XCTAssertTrue(id("camera.retake", in: app).exists)
        send.tap()
        let added = id("camera.harness.added", in: app)
        XCTAssertTrue(added.waitForExistence(timeout: 10))
        XCTAssertEqual(added.label, "photos=2 clips=1 sent=true")
    }
}
