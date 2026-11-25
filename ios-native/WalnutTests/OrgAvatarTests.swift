import Observation
import XCTest
import UIKit
@testable import Walnut

/// The Org avatar read (`GET /api/v1/org/avatars/<taskId>.png?size=`, src/web/routes/org-avatars-v1.ts):
/// its URL, the pixel size asked for, and how long one answer serves (the route's max-age=60).
@MainActor
final class OrgAvatarTests: XCTestCase {
    private let base = URL(string: "https://walnut.example:3456")!

    func testURLNamesTheTaskAndSize() {
        let url = WalnutAPI.orgAvatarURL(base: base, taskId: "lead-garden-1", pixels: 60)
        XCTAssertEqual(url?.absoluteString, "https://walnut.example:3456/api/v1/org/avatars/lead-garden-1.png?size=60")
    }

    func testURLKeepsTheIdOneSegmentAndClampsTheSize() {
        let slashed = WalnutAPI.orgAvatarURL(base: URL(string: "https://walnut.example/")!, taskId: "a/b c", pixels: 4_000)
        XCTAssertEqual(slashed?.absoluteString, "https://walnut.example/api/v1/org/avatars/a%2Fb%20c.png?size=512")
        XCTAssertEqual(WalnutAPI.orgAvatarURL(base: base, taskId: "x", pixels: 1)?.query, "size=16")
        XCTAssertNil(WalnutAPI.orgAvatarURL(base: base, taskId: "", pixels: 60))
    }

    func testPixelsArePointsTimesScale() {
        XCTAssertEqual(OrgAvatarLoader.pixels(points: 20, scale: 3), 60)
        XCTAssertEqual(OrgAvatarLoader.pixels(points: 34, scale: 2), 68)
        XCTAssertEqual(OrgAvatarLoader.pixels(points: 18.5, scale: 3), 56)
        XCTAssertEqual(OrgAvatarLoader.pixels(points: 4, scale: 1), 16)
    }

    /// One answer serves for a minute; after that the next view reads it again (an edited avatar
    /// shows on the next open), and a failed read keeps the picture shown.
    func testAnAnswerServesAMinuteThenIsReadAgain() async {
        var clock = Date(timeIntervalSince1970: 1_000)
        var calls = 0
        var fail = false
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let loader = OrgAvatarLoader(fetch: { _, _ in
            calls += 1
            if fail { throw APIError.badResponse }
            return png
        }, now: { clock })
        let key = OrgAvatarLoader.Key(server: "s", taskId: "lead-marina", pixels: 60)

        await loader.refresh(key, scale: 3)
        XCTAssertNotNil(loader.image(key))
        XCTAssertEqual(calls, 1)

        clock += 30
        await loader.refresh(key, scale: 3)
        XCTAssertEqual(calls, 1, "a fresh answer is not asked again")

        clock += 31
        fail = true
        await loader.refresh(key, scale: 3)
        XCTAssertEqual(calls, 2, "a stale answer is read again")
        XCTAssertNotNil(loader.image(key), "a failed read keeps the picture shown")

        loader.eraseAll()
        XCTAssertNil(loader.image(key))
    }

    /// A 404 (the experiment off) shows nothing new and is remembered, so a list does not ask on
    /// every row.
    func testNotFoundShowsNothingAndIsRemembered() async {
        var calls = 0
        let loader = OrgAvatarLoader(fetch: { _, _ in calls += 1; return nil }, now: { Date(timeIntervalSince1970: 5) })
        let key = OrgAvatarLoader.Key(server: "s", taskId: "main-1", pixels: 102)
        await loader.refresh(key, scale: 3)
        await loader.refresh(key, scale: 3)
        XCTAssertNil(loader.image(key))
        XCTAssertEqual(calls, 1)
    }

    /// An answer redraws only the views showing that avatar, and an answer the same as the last
    /// redraws none: a list's rows are not all redrawn as another row's avatar comes in.
    func testAnAnswerRedrawsOnlyItsOwnAvatar() async {
        var clock = Date(timeIntervalSince1970: 1_000)
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let loader = OrgAvatarLoader(fetch: { id, _ in id == "vp" ? nil : png }, now: { clock })
        let vp = OrgAvatarLoader.Key(server: "s", taskId: "vp", pixels: 68)
        let director = OrgAvatarLoader.Key(server: "s", taskId: "d1", pixels: 66)
        await loader.refresh(vp, scale: 2)

        var vpRedrawn = false
        withObservationTracking { _ = loader.image(vp) } onChange: { vpRedrawn = true }
        var directorRedrawn = false
        withObservationTracking { _ = loader.image(director) } onChange: { directorRedrawn = true }

        await loader.refresh(director, scale: 2)
        XCTAssertTrue(directorRedrawn, "the Director's own avatar did not redraw when it came in")
        XCTAssertFalse(vpRedrawn, "the VP's avatar redrew for the Director's answer")

        clock += 61
        await loader.refresh(vp, scale: 2)
        XCTAssertFalse(vpRedrawn, "the same 404 again redrew the VP's avatar")
    }

    /// An erase (Disconnect) forgets the picture but keeps the key's slot: a view that read the avatar
    /// before it is redrawn by the next pairing's answer, even when that answer is the same picture.
    func testAnEraseKeepsTheSlotSoTheNextAnswerRedrawsTheViewOnIt() async {
        var calls = 0
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }
        let loader = OrgAvatarLoader(fetch: { _, _ in calls += 1; return png }, now: { Date(timeIntervalSince1970: 1_000) })
        let key = OrgAvatarLoader.Key(server: "s", taskId: "lead-marina", pixels: 60)
        await loader.refresh(key, scale: 3)
        XCTAssertNotNil(loader.image(key))

        var erased = false
        withObservationTracking { _ = loader.image(key) } onChange: { erased = true }
        loader.eraseAll()
        XCTAssertTrue(erased, "the erase left the old picture on screen")
        XCTAssertNil(loader.image(key))

        // The view, redrawn by the erase, reads the avatar again; the next answer must reach it.
        var answered = false
        withObservationTracking { _ = loader.image(key) } onChange: { answered = true }
        await loader.refresh(key, scale: 3)
        XCTAssertEqual(calls, 2, "the erase did not forget the answer's time: no new read")
        XCTAssertTrue(answered, "the next pairing's answer did not redraw the view on the slot")
        XCTAssertNotNil(loader.image(key), "the same picture as before the erase did not show again")
    }
}
