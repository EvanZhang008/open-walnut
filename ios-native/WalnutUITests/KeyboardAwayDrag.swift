import XCTest

// A drag that puts the keyboard away starts off the field being typed in. A touch that lands on
// the focused field is that field's first (its text gestures), so it may move nothing: on CI the
// question card's drag from 0.75 of its box started on the six-line answer it had just grown,
// the cards did not move and the keyboard stayed up (2026-11-26, run 45784774186,
// AskQuestionCardUITests; the frames before and after the drag were the same). The start stays
// where the test asked when that is clear of the field; otherwise it moves to the middle of the
// larger clear stretch of the area on screen, under the navigation bar and above the keyboard.
// `tests/web/ios-keyboard-away-drag-guard.test.ts` keeps every keyboard-away drag coming here.

/// The screen y a keyboard-away drag inside `area` starts at: `preferredY` when it is clear of
/// `field` (with `clearance` to spare), else the middle of the larger clear stretch above or
/// below it. Fails the test when neither stretch is `minRoom` tall, rather than drag on the field.
func keyboardAwayDragY(
    _ app: XCUIApplication, in area: CGRect, avoiding field: XCUIElement, preferredY: CGFloat,
    clearance: CGFloat = 8, minRoom: CGFloat = 32, file: StaticString = #filePath, line: UInt = #line
) -> CGFloat {
    let nav = app.navigationBars.firstMatch
    let keyboard = app.keyboards.firstMatch
    let top = max(area.minY, nav.exists ? nav.frame.maxY : area.minY)
    let bottom = min(area.maxY, keyboard.exists ? keyboard.frame.minY : area.maxY)
    let taken = field.exists ? field.frame.insetBy(dx: 0, dy: -clearance) : .null
    if taken.isNull || preferredY < taken.minY || preferredY > taken.maxY { return preferredY }
    let above = (top, min(bottom, taken.minY))
    let below = (max(top, taken.maxY), bottom)
    let pick = (above.1 - above.0) >= (below.1 - below.0) ? above : below
    if pick.1 - pick.0 < minRoom {
        XCTFail("no room to start a drag off the field being typed in: area \(area), shown \(top)...\(bottom), "
                + "field \(field.frame)", file: file, line: line)
        return preferredY
    }
    return (pick.0 + pick.1) / 2
}
