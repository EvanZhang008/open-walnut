#if DEBUG
import Foundation

/// `-walnut.debugNotices YES` (Debug builds only): a launch posts a few sample notices that stay
/// up, so the notice stack can be looked at and screenshot without a server or a real event.
/// `-walnut.debugNotices one` posts only the newest ("debug.ok"), a lone card on the stack.
@MainActor
enum NoticeDebugSamples {
    static let argument = "walnut.debugNotices"

    static func postIfAsked(arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let at = arguments.firstIndex(where: { $0.contains(argument) }) else { return }
        let center = NoticeCenter.shared
        let lone = arguments.indices.contains(at + 1) && arguments[at + 1] == "one"
        if lone {
            center.post(ok)
            return
        }
        // The oldest: folded under the three newer ones into "1 more".
        center.post(NoticeItem(
            id: "debug.health", title: "Apple Health", status: "On", tone: .ok,
            preview: "Apple Health is on. Your Mac has your recent health data now.",
            avatar: .symbol("heart.fill"), life: .untilDismissed))
        center.post(NoticeItem(
            id: "debug.error", title: "Growth VP", status: "Couldn't open", tone: .error,
            preview: "Couldn't reach Growth VP: the request timed out.",
            avatar: .initials("GV"), life: .untilDismissed))
        center.post(NoticeItem(
            id: "debug.upload", title: "Photos", status: "Uploading", tone: .live,
            preview: "2 of 5", avatar: .symbol("photo.on.rectangle"), life: .untilDismissed))
        center.post(ok)
    }

    private static var ok: NoticeItem {
        NoticeItem(
            id: "debug.ok", title: "Tasks", status: "Done", tone: .ok,
            preview: "Pinned \u{00B7} Focus", avatar: .symbol("checklist"), life: .untilDismissed)
    }
}
#endif
