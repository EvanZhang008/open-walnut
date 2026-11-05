import SwiftUI
import WidgetKit

/// The widget extension: today only the lock-screen work card (a Live Activity).
@main
struct WalnutWidgetsBundle: WidgetBundle {
    var body: some Widget {
        WorkCardLiveActivity()
    }
}
