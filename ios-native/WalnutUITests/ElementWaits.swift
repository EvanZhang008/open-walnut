import XCTest

/// True once `element` reads `value`, within `timeout`.
///
/// A field's value follows what was typed into it a moment later: `typeText` returns once the keys
/// are sent, and reading `value` right after it read the first letters only on a busy runner
/// (2026-11-16, CI on iOS 26.5: "Ty" for "Typed without voice", "Q" for "Quick question"). A
/// count or a fold state read after a tap lags the same way. Every such read waits here;
/// `tests/web/ios-ui-test-typed-value-guard.test.ts` fails on a typed field read at once again.
@MainActor
func waitForValue(_ element: XCUIElement, _ value: String, timeout: TimeInterval = 15) -> Bool {
    let reads = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
    return XCTWaiter().wait(for: [reads], timeout: timeout) == .completed
}
