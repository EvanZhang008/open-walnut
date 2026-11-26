import XCTest

// Scrolling a list in a UI test by a distance the test controls, closed loop.
//
// A swipe flings, and how far a fling carries is the simulator's to decide: on a loaded one a
// 70 pt drag, even one held at its end, carried the Routines list 120 to 240 pt, so a helper that
// dragged a fixed step toward a 100 pt window jumped over it both ways eight times, gave up, and
// the test then measured a row parked under the navigation bar; the tap's own "scroll to visible"
// moved it, and the check read that as the app's jump (2026-11-17, lane B,
// RoutinesUITests.testTappedRowStaysPutUnderATallOpenRow 3 of 3; CI's swipes went past
// routines.row.r-acme-1 the same day). So every drag here is sized by the distance still to go,
// slow and held before it lifts, its effect is measured on the element and the next drag is
// scaled by it, and each look waits for the element to hold still first.
// `tests/web/ios-ui-test-list-scroll-guard.test.ts` keeps new scroll-until loops coming here.

/// Where a list row can be seen and tapped: under the navigation bar, and clear of the tab bar
/// (iOS 26's tab bar floats over the list, and a tap on a row under it lands on the bar) and of
/// the keyboard while one is up: a drag that starts on the keyboard never scrolls the list
/// (2026-11-26, CI: 24 drags from y 734 under a keyboard from y 540 left a thread's Follow up box
/// at y 1111).
func listBand(_ app: XCUIApplication, clearOfTabBar: CGFloat = 8) -> ClosedRange<CGFloat> {
    let nav = app.navigationBars.firstMatch
    let tabs = app.tabBars.firstMatch
    let keyboard = app.keyboards.firstMatch
    let top = nav.exists ? nav.frame.maxY : app.frame.minY
    let cover = min(tabs.exists ? tabs.frame.minY : app.frame.maxY, keyboard.exists ? keyboard.frame.minY : .infinity)
    let bottom = cover - clearOfTabBar
    return top...max(top + 1, bottom)
}

/// How far (points, down positive) a frame must move to lie inside `band`: 0 when it does. The
/// smallest move that gets it there with `margin` to spare, so what sits next to it stays in view.
/// A frame taller than the band is in place with its top in the band's upper half.
func distanceIntoBand(_ frame: CGRect, _ band: ClosedRange<CGFloat>, margin: CGFloat = 16) -> CGFloat {
    let lo = band.lowerBound, hi = band.upperBound
    if frame.height >= hi - lo {
        return frame.minY >= lo && frame.minY <= (lo + hi) / 2 ? 0 : lo + margin - frame.minY
    }
    if frame.minY >= lo - 1 && frame.maxY <= hi + 1 { return 0 }
    let room = min(margin, (hi - lo - frame.height) / 2)
    let top = frame.minY < lo ? lo + room : hi - room - frame.height
    return top - frame.minY
}

/// Drags the list `dy` points (down positive) in the middle of the list band (`shown`, else
/// `listBand`): a slow drag that holds before it lifts, so the list stops about where the finger does.
func dragList(_ app: XCUIApplication, by dy: CGFloat, in shown: ClosedRange<CGFloat>? = nil) {
    let band = shown ?? listBand(app)
    let mid = (band.lowerBound + band.upperBound) / 2
    let origin = app.coordinate(withNormalizedOffset: .zero)
    let from = origin.withOffset(CGVector(dx: app.frame.midX, dy: mid - dy / 2))
    let to = origin.withOffset(CGVector(dx: app.frame.midX, dy: mid + dy / 2))
    from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.5)
}

/// Scrolls the list until `need(frame)` reads 0 for `target`, in at most `tries` drags that aim
/// at it; true when it got there. `need` says how far (points, down positive) the element must
/// still move. An element the list has not built yet is looked for upward with `up`, else
/// downward, a band's height a drag for up to `searches` drags (at the largest text sizes a list
/// is a dozen screens long); one a drag carried out of the list (a lazy list drops it) is looked
/// for back the way it came. `band` is where the drags start and how far they go, when the list
/// shows less than `listBand` (a sticky header over its top).
@discardableResult
func scrollList(_ app: XCUIApplication, _ target: XCUIElement, up: Bool = false, tries: Int = 16,
                searches: Int = 30, band shown: (() -> ClosedRange<CGFloat>)? = nil,
                need: (CGRect) -> CGFloat) -> Bool {
    // Content moved per point of drag, learned from the element's own moves: under 1 for the
    // touch slop, over 1 when the simulator lets a held drag glide on.
    var gain: CGFloat = 1
    var toward: CGFloat = up ? 1 : -1
    // The shortest drag that moves the list: about 24 pt goes to the touch slop, and it doubles
    // after a drag that moved nothing.
    var least: CGFloat = 24
    var aimed = 0, searched = 0
    while aimed < tries, searched < searches {
        let band = shown?() ?? listBand(app)
        let room = max(60, band.upperBound - band.lowerBound - 60)
        guard target.exists, !target.frame.isEmpty else {
            // Not built yet: about a band's height a drag, so the row comes into the band.
            dragList(app, by: toward * room / max(1, gain), in: band)
            searched += 1
            continue
        }
        aimed += 1
        waitStill(target, timeout: 3)
        guard target.exists else { continue }
        let start = target.frame
        let wanted = need(start)
        if wanted == 0 { return true }
        toward = wanted > 0 ? 1 : -1
        let command = toward * min(room, max(least, abs(wanted) / gain))
        dragList(app, by: command, in: band)
        waitStill(target, timeout: 3)
        guard target.exists, !target.frame.isEmpty else {
            // Carried past the band and out of the list: back the other way, in shorter drags.
            toward = -toward
            gain = min(4, gain * 2)
            continue
        }
        let moved = target.frame.midY - start.midY
        if moved * command > 0, abs(moved) >= 4 {
            gain = min(4, max(0.25, moved / command))
        } else {
            least = min(room, least * 2)
        }
    }
    waitStill(target, timeout: 3)
    return target.exists && !target.frame.isEmpty && need(target.frame) == 0
}

/// Scrolls until `target` lies whole in the list band (`listBand`), moving the list as little as
/// that takes; true when it does.
@discardableResult
func revealInList(_ app: XCUIApplication, _ target: XCUIElement, up: Bool = false, tries: Int = 16) -> Bool {
    scrollList(app, target, up: up, tries: tries) { distanceIntoBand($0, listBand(app)) }
}
