import Cocoa
import UserNotifications
import WebKit

// The Mac app's macOS notifications for Walnut approvals (a script waits on `walnut approve`).
// The page asks through webkit.messageHandlers.walnutNotify.postMessage({op}) and gets a promise
// (web/src/components/approvals/approval-notify.ts):
//   {op:"status"}                    -> {status: "allowed" | "ask" | "off"}
//   {op:"post", id, title, body}     -> asks for permission once, then posts {posted, status}
//   {op:"clear", id}                 -> takes the notice back (the approval was answered)
//   {op:"keep", ids}                 -> takes back every approval notice not among ids (still waiting)
//   {op:"take"}                      -> {id} of a notice clicked before the page could hear it, once
//   {op:"settings"}                  -> opens System Settings at Walnut's notifications
// A click on a notice brings the window that posted it forward and sends the page the
// `walnut:open-approval` event, which opens that request. One notice per approval, however many
// windows post it. The page holds a notice back in quiet mode (Walnut's Do Not Disturb) unless
// quiet lets permission prompts through; macOS Focus applies on top, as for any app.
final class NotificationBridge: NSObject, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
    static let shared = NotificationBridge()
    static let handlerName = "walnutNotify"
    static let openEvent = "walnut:open-approval"

    /// The window to bring forward when the one that posted a notice is gone.
    var fallbackWebView: () -> WKWebView? = { nil }

    private var posted = Set<String>()
    private var poster: [String: WeakWebView] = [:]
    /// The last notice clicked, until a page takes it (the app was opening, or the page reloading).
    private var clicked: (id: String, at: Date)?

    private final class WeakWebView { weak var view: WKWebView?; init(_ v: WKWebView?) { view = v } }

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    /// Call once at launch, so a click that arrives while the app runs reaches the page.
    func install() {
        center.delegate = self
    }

    static func identifier(_ id: String) -> String { "walnut-approval-" + id }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // Only the console page itself, never a frame inside it (a session's web service, a plugin page).
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, let page = message.webView?.url,
              origin.protocol == page.scheme, origin.host == page.host, origin.port == (page.port ?? 0) else {
            replyHandler(nil, "notifications are posted only from the Walnut console page")
            return
        }
        let body = message.body as? [String: Any] ?? [:]
        func text(_ k: String, _ max: Int) -> String { String((body[k] as? String ?? "").prefix(max)) }
        let id = text("id", 80)
        switch body["op"] as? String ?? "" {
        case "status":
            status { replyHandler(["status": $0], nil) }
        case "post":
            guard !id.isEmpty else { replyHandler(nil, "no id"); return }
            post(id: id, title: text("title", 200), body: text("body", 400), from: message.webView) { replyHandler($0, nil) }
        case "clear":
            guard !id.isEmpty else { replyHandler(nil, "no id"); return }
            center.removeDeliveredNotifications(withIdentifiers: [Self.identifier(id)])
            center.removePendingNotificationRequests(withIdentifiers: [Self.identifier(id)])
            poster.removeValue(forKey: id)
            replyHandler(["cleared": true], nil)
        case "keep":
            let keep = Set((body["ids"] as? [Any] ?? []).compactMap { $0 as? String }.map(Self.identifier))
            center.getDeliveredNotifications { delivered in
                let stale = delivered.map(\.request.identifier).filter { $0.hasPrefix("walnut-approval-") && !keep.contains($0) }
                if !stale.isEmpty { self.center.removeDeliveredNotifications(withIdentifiers: stale) }
                DispatchQueue.main.async { replyHandler(["removed": stale.count], nil) }
            }
        case "take":
            if let c = clicked, Date().timeIntervalSince(c.at) < 120 {
                clicked = nil
                replyHandler(["id": c.id], nil)
            } else {
                clicked = nil
                replyHandler([:], nil)
            }
        case "settings":
            let bundle = Bundle.main.bundleIdentifier ?? ""
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundle)") {
                NSWorkspace.shared.open(url)
            }
            replyHandler(["opened": true], nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }

    private func status(_ done: @escaping (String) -> Void) {
        center.getNotificationSettings { s in
            let word: String
            switch s.authorizationStatus {
            case .authorized, .provisional: word = "allowed"
            case .notDetermined: word = "ask"
            default: word = "off"
            }
            DispatchQueue.main.async { done(word) }
        }
    }

    private func post(id: String, title: String, body: String, from view: WKWebView?, done: @escaping ([String: Any]) -> Void) {
        poster[id] = WeakWebView(view)
        if posted.contains(id) { done(["posted": false, "status": "already"]); return }
        posted.insert(id)
        center.requestAuthorization(options: [.alert, .sound]) { granted, err in
            DispatchQueue.main.async {
                guard granted else {
                    DesktopLogger.shared.log("approval_notice_off", fields: ["error": err?.localizedDescription ?? "denied"])
                    self.posted.remove(id)
                    done(["posted": false, "status": "off"])
                    return
                }
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.sound = .default
                content.userInfo = ["approvalId": id]
                content.threadIdentifier = "walnut-approvals"
                let req = UNNotificationRequest(identifier: Self.identifier(id), content: content, trigger: nil)
                self.center.add(req) { addErr in
                    DispatchQueue.main.async {
                        if let addErr {
                            self.posted.remove(id)
                            DesktopLogger.shared.log("approval_notice_failed", fields: ["error": addErr.localizedDescription])
                            done(["posted": false, "status": "error", "error": addErr.localizedDescription])
                        } else {
                            DesktopLogger.shared.log("approval_notice_posted", fields: ["approval": id])
                            done(["posted": true, "status": "allowed"])
                        }
                    }
                }
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Shown even while Walnut is in front: a script is blocked until someone answers.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let id = response.notification.request.content.userInfo["approvalId"] as? String ?? ""
        DispatchQueue.main.async {
            defer { completionHandler() }
            guard !id.isEmpty else { return }
            DesktopLogger.shared.log("approval_notice_clicked", fields: ["approval": id])
            // Kept until a page takes it: a page still loading hears nothing of the event below.
            self.clicked = (id, Date())
            NSApp.activate(ignoringOtherApps: true)
            guard let view = self.poster[id]?.view ?? self.fallbackWebView() else { return }
            view.window?.deminiaturize(nil)
            view.window?.makeKeyAndOrderFront(nil)
            guard let data = try? JSONSerialization.data(withJSONObject: ["id": id]), let detail = String(data: data, encoding: .utf8) else { return }
            view.evaluateJavaScript("window.dispatchEvent(new CustomEvent(\(Self.jsString(Self.openEvent)), { detail: \(detail) }))", completionHandler: nil)
        }
    }

    static func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }
}
