import XCTest

/// The task page's header (status circle, title, Watch eye) at every text size: each
/// control whole on screen and tappable, the largest accessibility size included.
/// In the in-app demo (`DemoMode`): nothing here writes to any server.
final class TaskPageLargeTypeUITests: XCTestCase {
    private static let demoURL = "https://demo.walnut.invalid"
    private static let demoToken = "walnut-demo-token"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    override func tearDown() {
        UITestLaunch.terminate()
        super.tearDown()
    }

    @MainActor
    func testHeaderControlsAreWholeAtTheLargestTextSize() throws {
        try checkHeader(size: "UICTContentSizeCategoryAccessibilityXXXL", name: "ax5")
    }

    @MainActor
    func testHeaderControlsAreWholeAtTheDefaultTextSize() throws {
        try checkHeader(size: nil, name: "default")
    }

    @MainActor
    private func checkHeader(size: String?, name: String) throws {
        var arguments = [UITestLaunch.serverURLArgument, Self.demoURL, "-walnut.deviceToken", Self.demoToken]
        if let size { arguments += ["-UIPreferredContentSizeCategoryName", size] }
        let app = UITestLaunch.launch(arguments)
        try openTaskPage(app)
        attach(app, "\(name)-task-page")

        let window = app.windows.firstMatch.frame
        let eye = app.buttons["task.watchToggle"]
        let status = app.buttons["task.statusToggle"]
        XCTAssertTrue(eye.waitForExistence(timeout: 10), "no Watch button on the task page")
        for (label, control) in [("Watch", eye), ("Status", status)] {
            let frame = control.frame
            XCTAssertTrue(control.isHittable, "\(label) is not tappable at \(name)")
            XCTAssertGreaterThanOrEqual(frame.minX, window.minX - 0.5, "\(label) runs off the left edge at \(name): \(frame)")
            XCTAssertLessThanOrEqual(frame.maxX, window.maxX + 0.5, "\(label) runs off the right edge at \(name): \(frame)")
            // 44pt, as the medium-detent sheet draws it (about 0.96 of the screen's scale).
            XCTAssertGreaterThanOrEqual(frame.width, 41, "\(label) is narrower than a fingertip at \(name): \(frame)")
            XCTAssertGreaterThanOrEqual(frame.height, 41, "\(label) is shorter than a fingertip at \(name): \(frame)")
        }
        // Nothing of the eye is drawn outside its button: the strip between the button and
        // the sheet's edge is bare (a 44pt box once held a glyph that grew with the text
        // size, and the sheet's edge cut it off).
        let shot = app.screenshot()
        let strip = CGRect(x: eye.frame.maxX + 1, y: eye.frame.minY + 2, width: 10, height: eye.frame.height - 4)
        let ink = Self.inkPixels(shot, in: strip, screenWidth: window.width)
        XCTAssertLessThan(ink, 30, "the eye spills \(ink) pixels past its button at \(name)")
        // Below the navigation bar: nothing of the header hides under it.
        let bar = app.navigationBars["Task"].frame
        XCTAssertGreaterThanOrEqual(eye.frame.minY, bar.maxY - 0.5, "Watch sits under the navigation bar at \(name): \(eye.frame) vs \(bar)")
        // The eye still works: one tap watches, another stops watching.
        let before = eye.value as? String
        eye.tap()
        let flipped = NSPredicate(format: "value != %@", before ?? "")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: flipped, evaluatedWith: eye)], timeout: 10), .completed,
                       "Watch did not change at \(name)")
        attach(app, "\(name)-watched")
        eye.tap()
        let restored = NSPredicate(format: "value == %@", before ?? "")
        XCTAssertEqual(XCTWaiter().wait(for: [expectation(for: restored, evaluatedWith: eye)], timeout: 10), .completed)
    }

    /// Pixels in `rect` (points) that stand out from the strip's usual color: a glyph's
    /// stroke, not the sheet behind it.
    static func inkPixels(_ shot: XCUIScreenshot, in rect: CGRect, screenWidth: CGFloat) -> Int {
        guard let image = shot.image.cgImage, screenWidth > 0 else { return 0 }
        let scale = CGFloat(image.width) / screenWidth
        let pixels = CGRect(x: rect.minX * scale, y: rect.minY * scale,
                            width: rect.width * scale, height: rect.height * scale).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard !pixels.isEmpty, let crop = image.cropping(to: pixels) else { return 0 }
        let w = crop.width, h = crop.height
        var bytes = [UInt8](repeating: 0, count: w * h * 4)
        let drawn: Bool = bytes.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8,
                                          bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return 0 }
        var luma: [Int] = []
        luma.reserveCapacity(w * h)
        for i in stride(from: 0, to: bytes.count, by: 4) {
            luma.append((Int(bytes[i]) * 299 + Int(bytes[i + 1]) * 587 + Int(bytes[i + 2]) * 114) / 1000)
        }
        let usual = luma.sorted()[luma.count / 2]
        return luma.filter { abs($0 - usual) > 60 }.count
    }

    /// The board drawer's first row, its long-press menu, Details.
    @MainActor
    private func openTaskPage(_ app: XCUIApplication) throws {
        let tasks = app.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30), "the tab bar never appeared")
        tasks.tap()
        let scrim = app.descendants(matching: .any)["tasks.drawer.scrim"]
        if !scrim.waitForExistence(timeout: 3) {
            let menu = app.buttons["tasks.menu"]
            XCTAssertTrue(menu.waitForExistence(timeout: 10), "no board button on the Tasks page")
            menu.tap()
        }
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'board.row.'")).firstMatch
        guard row.waitForExistence(timeout: 45) else {
            attach(app, "board-not-ready")
            throw XCTSkip("the demo board has no rows")
        }
        let ready = expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: row)
        XCTAssertEqual(XCTWaiter().wait(for: [ready], timeout: 10), .completed, "the first row never became hittable")
        row.press(forDuration: 1.0)
        let details = app.buttons["Details, dates & priority"]
        XCTAssertTrue(details.waitForExistence(timeout: 5), "no Details item in the row menu")
        details.tap()
        XCTAssertTrue(app.navigationBars["Task"].waitForExistence(timeout: 10), "the task page did not open")
        XCTAssertTrue(app.buttons["task.title"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
