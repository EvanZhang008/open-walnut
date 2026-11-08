/**
 * Walnut's actions for Spotlight, Shortcuts and Siri (App Intents): Quick question (a quick answer),
 * Tell CEO (a message into the CEO's chat, the Main task) and Open Task. The type names
 * (AskWalnutIntent, TellMainIntent) are the actions' identifiers and stay, so a quick key or a
 * Shortcut the user already made keeps working; only the words people read changed. On macOS 26 each one shows in Spotlight's
 * actions and can be given a quick key there, so a key anywhere on the Mac reaches Walnut with
 * nothing else installed. They call the same local routes the Alfred and Raycast launchers use
 * (src/web/routes/quick-input-v1.ts).
 *
 * The system runs an intent inside this app (launching it when it is not running), so the port is
 * the one the app's server is on; while that server is still starting, a call waits for it.
 *
 * The release still runs on macOS 12, where these types do not exist: hence @available, and the
 * framework is weak-linked.
 *
 * build.sh / build-release.sh run Xcode's appintentsmetadataprocessor over this file's compiled
 * constants; without that step the app still builds, and the actions are simply not listed.
 */

import AppIntents
import Foundation
import Cocoa

/// Set by the AppDelegate: the port its server answers on, nil while it is starting.
enum WalnutIntentsPort {
    @MainActor static var provider: (() -> Int?)?
}

@available(macOS 13.0, *)
enum WalnutIntentsServer {
    @MainActor static func base() -> URL {
        let port = WalnutIntentsPort.provider?() ?? 3456
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    /// One request to the local server, waiting up to `startupWait` seconds for a server that is
    /// not listening yet (the app was just launched to run this action).
    static func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                        timeout: TimeInterval = 15, startupWait: TimeInterval = 25) async throws -> (Data, Int) {
        let deadline = Date().addingTimeInterval(startupWait)
        while true {
            let base = await base()
            // Relative to the base, so a path's own query stays a query (appendingPathComponent
            // would escape its "?").
            guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw WalnutIntentError.failed("Bad request path.") }
            var req = URLRequest(url: url, timeoutInterval: timeout)
            req.httpMethod = method
            if let body {
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
            } catch let error as URLError where error.code == .cannotConnectToHost
                        || (method == "GET" && error.code == .networkConnectionLost) {
                // A dropped connection may have carried a POST through already: only a refused
                // connect is safe to send again.
                if Date() >= deadline { throw WalnutIntentError.notRunning }
                try await Task.sleep(nanoseconds: 700_000_000)
            }
        }
    }

    static func errorText(_ data: Data, status: Int) -> String {
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return (body?["error"] as? String) ?? "Walnut answered HTTP \(status)."
    }
}

@available(macOS 13.0, *)
enum WalnutIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notRunning
    case failed(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notRunning: return "Walnut is not answering on this Mac yet. Open the Walnut app, then try again."
        case .failed(let text): return "\(text)"
        }
    }
}

@available(macOS 13.0, *)
struct AskWalnutIntent: AppIntent {
    static let title: LocalizedStringResource = "Quick Question"
    static let description = IntentDescription("A quick answer from Walnut: a question, a text to revise or translate, a short search.")
    static let openAppWhenRun = false

    @Parameter(title: "Question", inputOptions: String.IntentInputOptions(multiline: true))
    var question: String

    static var parameterSummary: some ParameterSummary { Summary("Quick question \(\.$question)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw WalnutIntentError.failed("Type a question first.") }
        let (data, status) = try await WalnutIntentsServer.request(
            "api/v1/quick/ask", method: "POST", body: ["text": text], timeout: 60)
        guard (200..<300).contains(status) else {
            throw WalnutIntentError.failed(WalnutIntentsServer.errorText(data, status: status))
        }
        // The route streams NDJSON lines; Spotlight shows one finished answer, so read them all.
        var answer = ""
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            guard let value = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any],
                  let type = value["type"] as? String else { continue }
            if type == "text" { answer += value["delta"] as? String ?? "" }
            if type == "result" { answer = value["text"] as? String ?? answer }
            if type == "error" { throw WalnutIntentError.failed(value["message"] as? String ?? "The answer failed.") }
        }
        if answer.isEmpty { throw WalnutIntentError.failed("Walnut gave no answer.") }
        return .result(value: answer, dialog: "\(answer)")
    }
}

@available(macOS 13.0, *)
struct TellMainIntent: AppIntent {
    static let title: LocalizedStringResource = "Tell Walnut CEO"
    static let description = IntentDescription("Send a message to Walnut's CEO. Its reply shows in the CEO's chat in Walnut.")
    static let openAppWhenRun = false

    @Parameter(title: "Message", inputOptions: String.IntentInputOptions(multiline: true))
    var message: String

    static var parameterSummary: some ParameterSummary { Summary("Tell CEO \(\.$message)") }

    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw WalnutIntentError.failed("Type a message first.") }
        let (data, status) = try await WalnutIntentsServer.request(
            "api/v1/quick/main", method: "POST", body: ["text": text], timeout: 30)
        guard (200..<300).contains(status) else {
            throw WalnutIntentError.failed(WalnutIntentsServer.errorText(data, status: status))
        }
        let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if body?["held"] as? Bool == true {
            let words = "The CEO is waiting for your answer to its question first, so nothing was sent. Open the CEO in Walnut to answer it."
            return .result(value: words, dialog: "\(words)")
        }
        let words = "Sent to the CEO. Its reply shows in the CEO's chat in Walnut."
        return .result(value: words, dialog: "\(words)")
    }
}

@available(macOS 13.0, *)
struct WalnutTaskEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "Walnut Task"
    static let defaultQuery = WalnutTaskQuery()

    var id: String
    var title: String
    var subtitle: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
    }
}

@available(macOS 13.0, *)
struct WalnutTaskQuery: EntityStringQuery {
    func entities(matching string: String) async throws -> [WalnutTaskEntity] {
        try await find(string)
    }

    func entities(for identifiers: [String]) async throws -> [WalnutTaskEntity] {
        // An id is the task itself; nothing to look up to open it.
        identifiers.map { WalnutTaskEntity(id: $0, title: $0, subtitle: "") }
    }

    /// What the picker lists before any words: the open tasks, the ones needing the user first.
    func suggestedEntities() async throws -> [WalnutTaskEntity] {
        try await find("", recent: true)
    }

    private func find(_ words: String, recent: Bool = false) async throws -> [WalnutTaskEntity] {
        let q = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty || recent else { return [] }
        var path = URLComponents(string: "api/v1/quick/tasks")!
        path.queryItems = [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: recent ? "20" : "12")]
        if recent { path.queryItems?.append(URLQueryItem(name: "recent", value: "1")) }
        let (data, status) = try await WalnutIntentsServer.request(path.string!, startupWait: 5)
        guard (200..<300).contains(status),
              let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let tasks = body["tasks"] as? [[String: Any]] else { return [] }
        return tasks.compactMap { t in
            guard let id = t["id"] as? String, let title = t["title"] as? String else { return nil }
            let parts = [t["stateLabel"] as? String, t["project"] as? String].compactMap { $0 }.filter { !$0.isEmpty }
            return WalnutTaskEntity(id: id, title: title, subtitle: parts.joined(separator: " · "))
        }
    }
}

@available(macOS 13.0, *)
struct OpenWalnutTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Walnut Task"
    static let description = IntentDescription("Find a task by its words and open it in Walnut.")
    static let openAppWhenRun = true

    @Parameter(title: "Task")
    var task: WalnutTaskEntity

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$task)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        var link = URLComponents(string: "open-walnut://open")!
        link.queryItems = [URLQueryItem(name: "to", value: "/tasks/\(task.id)")]
        if let url = link.url { NSWorkspace.shared.open(url) }
        return .result()
    }
}

@available(macOS 13.0, *)
struct WalnutShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        // The older spoken phrases stay after the new ones, so what a user already says to
        // Siri still works.
        AppShortcut(intent: AskWalnutIntent(), phrases: ["Quick question for \(.applicationName)", "Ask \(.applicationName)"],
                    shortTitle: "Quick Question", systemImageName: "bolt.fill")
        AppShortcut(intent: TellMainIntent(), phrases: ["Tell \(.applicationName) CEO", "Tell \(.applicationName) Main"],
                    shortTitle: "Tell CEO", systemImageName: "person.fill")
        AppShortcut(intent: OpenWalnutTaskIntent(), phrases: ["Open \(\.$task) in \(.applicationName)", "Open a task in \(.applicationName)"],
                    shortTitle: "Open Task", systemImageName: "checklist")
    }
}
