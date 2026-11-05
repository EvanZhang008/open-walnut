import SwiftUI
import WidgetKit

/// The widget extension's Live Activities: the lock-screen work card and a
/// Talk to Walnut take.
@main
struct WalnutWidgetsBundle: WidgetBundle {
    var body: some Widget {
        WorkCardLiveActivity()
        TalkLiveActivityWidget()
    }
}
