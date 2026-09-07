import XCTest
@testable import Walnut

/// The Chat tab's left-edge drawer, in the part a screenshot cannot judge: which
/// drags belong to it, and where a released drag lands.
///
/// Every case here is a way the gesture can be wrong ON A DEVICE and right in a
/// still image. A drawer that claims a vertical drag makes the transcript
/// unscrollable near the left edge; one that ignores velocity refuses a fast
/// flick that only travelled 30pt; one that forgets to clamp lets a long drag
/// push the chat off the far side of the screen.
final class ChatDrawerGeometryTests: XCTestCase {

    // MARK: - Width

    /// A share of the screen on a phone, so the sliver of chat left showing says
    /// the conversation is still there.
    func testWidthIsAShareOfANarrowContainer() {
        XCTAssertEqual(ChatDrawerGeometry.width(container: 393), 393 * 0.82, accuracy: 0.001)
    }

    /// Capped on anything wide, so it stays a drawer instead of becoming a page.
    func testWidthIsCappedOnAWideContainer() {
        XCTAssertEqual(ChatDrawerGeometry.width(container: 1024), ChatDrawerGeometry.maxWidth)
    }

    /// Before the first layout there is no container. The drawer still has to
    /// have a width, or the very first drag divides by zero.
    func testWidthFallsBackToTheCapBeforeLayout() {
        XCTAssertEqual(ChatDrawerGeometry.width(container: 0), ChatDrawerGeometry.maxWidth)
    }

    // MARK: - Which drags are the drawer's

    func testAPullFromTheLeadingEdgeOpens() {
        XCTAssertTrue(ChatDrawerGeometry.tracksDrag(
            startX: 8, translation: CGSize(width: 40, height: 5), isOpen: false
        ))
    }

    /// The edge zone is the whole gate while shut: a rightward drag from the
    /// middle of the transcript is a swipe on a message, not the drawer.
    func testAPullFromTheMiddleDoesNotOpen() {
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 180, translation: CGSize(width: 60, height: 4), isOpen: false
        ))
    }

    func testTheEdgeZoneIsInclusiveAtItsBoundary() {
        XCTAssertTrue(ChatDrawerGeometry.tracksDrag(
            startX: ChatDrawerGeometry.edgeZone,
            translation: CGSize(width: 30, height: 0), isOpen: false
        ))
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: ChatDrawerGeometry.edgeZone + 1,
            translation: CGSize(width: 30, height: 0), isOpen: false
        ))
    }

    /// THE ONE THAT BREAKS SCROLLING. A drag down the transcript that starts near
    /// the left edge and drifts sideways must stay the scroll view's.
    func testAMostlyVerticalDragIsNeverTheDrawers() {
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 6, translation: CGSize(width: 20, height: 90), isOpen: false
        ))
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 6, translation: CGSize(width: 20, height: 90), isOpen: true
        ))
    }

    /// Sideways has to WIN by the dominance margin, not merely tie: at 45° the
    /// drag is still ambiguous and the scroll view is the safer owner.
    func testADiagonalDragNeedsToBeClearlySideways() {
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 4, translation: CGSize(width: 30, height: 28), isOpen: false
        ))
        XCTAssertTrue(ChatDrawerGeometry.tracksDrag(
            startX: 4, translation: CGSize(width: 30, height: 10), isOpen: false
        ))
    }

    /// An OPEN drawer answers to a leftward drag from anywhere — its own rows, the
    /// scrim, the sliver of chat — because that is how it gets pushed back.
    func testAnOpenDrawerClosesFromAnywhere() {
        XCTAssertTrue(ChatDrawerGeometry.tracksDrag(
            startX: 300, translation: CGSize(width: -50, height: 3), isOpen: true
        ))
    }

    /// Open and dragged further right there is nowhere to go, so the drag is not
    /// claimed at all (the drawer must not rubber-band over the chat).
    func testAnOpenDrawerIgnoresAFurtherRightwardDrag() {
        XCTAssertFalse(ChatDrawerGeometry.tracksDrag(
            startX: 100, translation: CGSize(width: 50, height: 2), isOpen: true
        ))
    }

    // MARK: - Progress

    func testProgressFollowsTheFingerAcrossTheDrawersWidth() {
        XCTAssertEqual(
            ChatDrawerGeometry.progress(from: 0, translationX: 160, width: 320),
            0.5, accuracy: 0.0001
        )
    }

    func testProgressResumesFromWhereTheDrawerAlreadyWas() {
        XCTAssertEqual(
            ChatDrawerGeometry.progress(from: 1, translationX: -80, width: 320),
            0.75, accuracy: 0.0001
        )
    }

    /// Clamped at both ends: an overshoot must not push the chat off the screen
    /// or drag the drawer back past its own edge.
    func testProgressIsClampedAtBothEnds() {
        XCTAssertEqual(ChatDrawerGeometry.progress(from: 0, translationX: 900, width: 320), 1)
        XCTAssertEqual(ChatDrawerGeometry.progress(from: 1, translationX: -900, width: 320), 0)
    }

    /// A drag that arrives before the first layout has no width to scale against.
    /// Freezing beats dividing by zero.
    func testProgressWithoutAWidthHoldsStill() {
        XCTAssertEqual(ChatDrawerGeometry.progress(from: 0.4, translationX: 200, width: 0), 0.4)
    }

    // MARK: - The tab bar getting out of the way

    /// Shut drawer, tab bar present. Anything else and the Chat tab loses its tab
    /// bar for good.
    func testTheTabBarStaysWhileTheDrawerIsShut() {
        XCTAssertFalse(ChatDrawerGeometry.tabBarHidden(progress: 0))
    }

    /// THE FLICKER CASE. A 1pt twitch at the start of a drag (1/320 of the way
    /// out) must not blink the tab bar out and back.
    func testAOnePointTwitchDoesNotHideTheTabBar() {
        let progress = ChatDrawerGeometry.progress(from: 0, translationX: 1, width: 320)
        XCTAssertFalse(ChatDrawerGeometry.tabBarHidden(progress: progress))
    }

    /// The bar leaves EARLY, so it travels with the drawer instead of vanishing
    /// after it has arrived.
    func testTheTabBarLeavesEarlyInTheDrag() {
        XCTAssertTrue(ChatDrawerGeometry.tabBarHidden(progress: 0.2))
        XCTAssertTrue(ChatDrawerGeometry.tabBarHidden(progress: 1))
    }

    /// Exactly at the threshold the bar is still there: the boundary belongs to
    /// the state that changes nothing.
    func testTheThresholdItselfKeepsTheTabBar() {
        XCTAssertFalse(
            ChatDrawerGeometry.tabBarHidden(progress: ChatDrawerGeometry.tabBarHideProgress)
        )
        XCTAssertTrue(
            ChatDrawerGeometry.tabBarHidden(progress: ChatDrawerGeometry.tabBarHideProgress + 0.001)
        )
    }

    // MARK: - Handing the tab bar's room back to the chat

    /// Nothing to compensate while the bar is there.
    func testNoCompensationWhileTheTabBarIsPresent() {
        XCTAssertEqual(
            ChatDrawerGeometry.tabBarCompensation(pageHeight: 800, tallestWithTabBar: 800), 0
        )
    }

    /// The bar's room, handed back: without this the composer drops by exactly
    /// this much the moment the drawer starts opening.
    func testTheBarsRoomIsHandedBackWhileItIsHidden() {
        XCTAssertEqual(
            ChatDrawerGeometry.tabBarCompensation(pageHeight: 849, tallestWithTabBar: 800), 49
        )
    }

    /// Never negative: a page SHORTER than the remembered one (the keyboard is up)
    /// must not pull the composer down into the keyboard.
    func testCompensationNeverGoesNegative() {
        XCTAssertEqual(
            ChatDrawerGeometry.tabBarCompensation(pageHeight: 500, tallestWithTabBar: 800), 0
        )
    }

    func testTheRememberedHeightGrowsToTheTallestSeenWithTheBar() {
        var remembered = ChatDrawerGeometry.rememberedHeight(
            tallestWithTabBar: 0, pageHeight: 800, tabBarHidden: false
        )
        XCTAssertEqual(remembered, 800)
        remembered = ChatDrawerGeometry.rememberedHeight(
            tallestWithTabBar: remembered, pageHeight: 802, tabBarHidden: false
        )
        XCTAssertEqual(remembered, 802)
    }

    /// THE KEYBOARD TRAP. A "last height seen with the bar" would record the
    /// keyboard-shrunk page, and the next open (which dismisses the keyboard AND
    /// hides the bar) would compensate by the keyboard's height too, shoving the
    /// composer up over the transcript. The running maximum ignores it.
    func testAKeyboardShrunkPageDoesNotBecomeTheRememberedHeight() {
        let remembered = ChatDrawerGeometry.rememberedHeight(
            tallestWithTabBar: 800, pageHeight: 460, tabBarHidden: false
        )
        XCTAssertEqual(remembered, 800)
        XCTAssertEqual(
            ChatDrawerGeometry.tabBarCompensation(pageHeight: 849, tallestWithTabBar: remembered),
            49
        )
    }

    /// A page measured with the bar already gone can never teach this value —
    /// adopting it would make the compensation zero and defeat itself.
    func testAHiddenBarPageNeverUpdatesTheRememberedHeight() {
        XCTAssertEqual(
            ChatDrawerGeometry.rememberedHeight(
                tallestWithTabBar: 800, pageHeight: 849, tabBarHidden: true
            ),
            800
        )
    }

    // MARK: - Settle

    /// A fast flick decides on its own. This is the case a pure midpoint rule
    /// gets wrong: 20pt of travel, released at speed, must still open.
    func testAFastFlickOpensFromBarelyMoved() {
        XCTAssertTrue(ChatDrawerGeometry.settlesOpen(progress: 0.06, velocityX: 1200))
    }

    func testAFastFlickBackClosesFromAlmostFullyOpen() {
        XCTAssertFalse(ChatDrawerGeometry.settlesOpen(progress: 0.95, velocityX: -1200))
    }

    /// Released slowly, position decides.
    func testASlowReleasePastTheMidpointOpens() {
        XCTAssertTrue(ChatDrawerGeometry.settlesOpen(progress: 0.51, velocityX: 0))
        XCTAssertFalse(ChatDrawerGeometry.settlesOpen(progress: 0.49, velocityX: 0))
    }

    /// Exactly half open settles OPEN: the user got the drawer halfway out, and
    /// showing what they were reaching for beats hiding it.
    func testTheMidpointItselfOpens() {
        XCTAssertTrue(ChatDrawerGeometry.settlesOpen(progress: 0.5, velocityX: 0))
    }

    /// A drift slower than the flick threshold is NOT a flick, so position still
    /// decides — otherwise a slow correction at the end of a drag would fling the
    /// drawer the way the finger happened to be creeping.
    func testASlowDriftDoesNotCountAsAFlick() {
        XCTAssertFalse(ChatDrawerGeometry.settlesOpen(
            progress: 0.2, velocityX: ChatDrawerGeometry.flickVelocity - 1
        ))
        XCTAssertTrue(ChatDrawerGeometry.settlesOpen(
            progress: 0.8, velocityX: -(ChatDrawerGeometry.flickVelocity - 1)
        ))
    }
}
