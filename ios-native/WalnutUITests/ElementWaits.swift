import XCTest

/// True once `element` matches `format` (an NSPredicate over the element: `isEnabled == false`,
/// `isHittable == true`), within `timeout`.
///
/// What the app shows follows a key press or a tap a moment later: reading a state at once read the
/// one before on a busy runner (2026-11-16, CI on iOS 26.5: Save still on right after the name was
/// deleted). Every such read waits here.
func waitToMatch(_ element: XCUIElement, _ format: String, timeout: TimeInterval = 15) -> Bool {
    waitToMatch(element, NSPredicate(format: format), timeout: timeout)
}

func waitToMatch(_ element: XCUIElement, _ predicate: NSPredicate, timeout: TimeInterval = 15) -> Bool {
    let reads = XCTNSPredicateExpectation(predicate: predicate, object: element)
    return XCTWaiter().wait(for: [reads], timeout: timeout) == .completed
}

/// True once `element` reads `value`, within `timeout`.
///
/// A field's value follows what was typed into it a moment later: `typeText` returns once the keys
/// are sent, and reading `value` right after it read the first letters only on a busy runner
/// (2026-11-16, CI on iOS 26.5: "Ty" for "Typed without voice", "Q" for "Quick question"). A
/// count or a fold state read after a tap lags the same way. Every such read waits here;
/// `tests/web/ios-ui-test-typed-value-guard.test.ts` fails on a typed field read at once again.
func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 15) -> Bool {
    waitToMatch(element, NSPredicate(format: "value == %@", value), timeout: timeout)
}

/// True once `element` is off the screen, within `timeout`: it no longer exists, or it has no frame.
///
/// A sheet that closed can leave its views in the accessibility tree a while with a frame of
/// {inf, inf, 0, 0}: `exists` still reads true though nothing shows (2026-11-26, CI on iOS 26.6:
/// RoutinesUITests' Edit sheet had closed and its row showed the new task, yet
/// `routines.editor.taskCurrent` existed at {inf, inf} past the 5 s wait). Every check that a
/// sheet closed waits here; `tests/web/ios-sheet-closed-guard.test.ts` fails on an `exists == false`
/// one again.
func waitOffScreen(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    waitToMatch(element, NSPredicate { object, _ in
        guard let e = object as? XCUIElement else { return false }
        return !e.exists || e.frame.isEmpty
    }, timeout: timeout)
}

/// True once `element` exists and its frame reads the same twice, 0.3 s apart, within `timeout`.
///
/// A row in a drawer that is still sliding in, or a button on a page that is still coming back,
/// is already hittable while it moves; a long press on it is cancelled by the motion and no menu
/// comes (2026-11-16, CI on iOS 26.5: the board row's menu in TaskPageLargeTypeUITests, the chat
/// drawer in ChatPlaceUITests).
@discardableResult
func waitStill(_ element: XCUIElement, timeout: TimeInterval = 5) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    var last: CGRect?
    while Date() < end {
        let now: CGRect? = element.exists ? element.frame : nil
        if let now, !now.isEmpty, now == last { return true }
        last = now
        // A poll between two reads of the frame, not a wait for the work: the loop ends on the reads.
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    }
    return false
}

/// A long press that holds still first (`waitStill`). Every long press on an element goes through
/// here; `tests/web/ios-ui-test-long-press-guard.test.ts` fails on a bare one.
func longPress(_ element: XCUIElement, _ duration: TimeInterval = 1.0) {
    waitStill(element)
    element.press(forDuration: duration)
}
