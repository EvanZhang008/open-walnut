import XCTest

/// Two fingers dragged together, through XCTest's own event synthesizer.
///
/// XCUIElement has no two-finger DRAG (only `twoFingerTap`, pinch and rotate), and
/// the gesture the Inbox has to answer is exactly that one: two fingers pulled down
/// the rows, the system's way into multiple selection (Mail, Files, Messages). The
/// classes below are the ones every XCUITest tap already goes through
/// (`XCPointerEventPath` per finger, one `XCSynthesizedEventRecord`), reached by
/// name because XCTest does not export them. A test SKIPS when they are missing, so
/// an Xcode that renames them reads as "not run", never as a pass.
enum MultiTouch {

    private typealias InitTouch = @convention(c) (AnyObject, Selector, CGPoint, Double) -> AnyObject
    private typealias MoveTo = @convention(c) (AnyObject, Selector, CGPoint, Double) -> Void
    private typealias Lift = @convention(c) (AnyObject, Selector, Double) -> Void
    private typealias InitRecord = @convention(c) (AnyObject, Selector, NSString, Int) -> AnyObject
    private typealias AddPath = @convention(c) (AnyObject, Selector, AnyObject) -> Void
    private typealias Synthesize = @convention(c) (AnyObject, Selector, AutoreleasingUnsafeMutablePointer<NSError?>?) -> Bool

    /// Press two fingers `spacing` apart (side by side) at `start`, drag them
    /// together to `end` over `duration` seconds in small steps, lift both.
    /// Points are screen points, the space `XCUIElement.frame` reports.
    static func twoFingerDrag(from start: CGPoint, to end: CGPoint, spacing: CGFloat = 40,
                              duration: TimeInterval = 1.2) throws {
        guard let pathClass = NSClassFromString("XCPointerEventPath"),
              let recordClass = NSClassFromString("XCSynthesizedEventRecord") else {
            throw XCTSkip("this XCTest has no XCPointerEventPath / XCSynthesizedEventRecord")
        }
        let initTouch = NSSelectorFromString("initForTouchAtPoint:offset:")
        let moveTo = NSSelectorFromString("moveToPoint:atOffset:")
        let lift = NSSelectorFromString("liftUpAtOffset:")
        let initRecord = NSSelectorFromString("initWithName:interfaceOrientation:")
        let addPath = NSSelectorFromString("addPointerEventPath:")
        let synthesize = NSSelectorFromString("synthesizeWithError:")
        for (cls, sel) in [(pathClass, initTouch), (pathClass, moveTo), (pathClass, lift),
                           (recordClass, initRecord), (recordClass, addPath), (recordClass, synthesize)]
        where class_getInstanceMethod(cls, sel) == nil {
            throw XCTSkip("\(cls) does not answer \(sel)")
        }

        func alloc(_ cls: AnyClass) -> AnyObject {
            (cls as AnyObject).perform(NSSelectorFromString("alloc")).takeUnretainedValue()
        }
        func imp<T>(_ cls: AnyClass, _ sel: Selector, as: T.Type) -> T {
            unsafeBitCast(class_getMethodImplementation(cls, sel), to: T.self)
        }

        // portrait = UIInterfaceOrientation.portrait (1)
        let record = imp(recordClass, initRecord, as: InitRecord.self)(
            alloc(recordClass), initRecord, "two-finger drag" as NSString, 1
        )
        let steps = 24
        for finger in 0..<2 {
            let dx = CGFloat(finger) * spacing
            let path = imp(pathClass, initTouch, as: InitTouch.self)(
                alloc(pathClass), initTouch, CGPoint(x: start.x + dx, y: start.y), 0
            )
            let move = imp(pathClass, moveTo, as: MoveTo.self)
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                let point = CGPoint(x: start.x + dx + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
                move(path, moveTo, point, duration * t)
            }
            imp(pathClass, lift, as: Lift.self)(path, lift, duration + 0.05)
            imp(recordClass, addPath, as: AddPath.self)(record, addPath, path)
        }
        var error: NSError?
        let ok = imp(recordClass, synthesize, as: Synthesize.self)(record, synthesize, &error)
        if !ok { throw error ?? NSError(domain: "MultiTouch", code: 1, userInfo: [NSLocalizedDescriptionKey: "synthesis failed"]) }
    }
}
