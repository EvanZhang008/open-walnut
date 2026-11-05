import Foundation
import Observation

/// One Org node's Threads as the phone holds them: read from the server, and written one action
/// at a time (Acknowledge, Snooze, Pin, Reopen, Follow up), each followed by a fresh read so the
/// page shows what the server keeps.
@Observable
@MainActor
final class OrgThreadsStore {
    let taskId: String
    /// nil until the first read answers.
    private(set) var threads: [OrgThread]?
    private(set) var error: String?
    /// The thread an action is running on (its buttons wait).
    private(set) var busyThreadId: String?
    private(set) var loading = false
    /// When a Follow up of his went out, per thread: the card says so at once, whatever the reload shows.
    private(set) var followUpSentAt: [String: Date] = [:]
    /// Where the last action moved its thread ("Moved to In progress"), shown for a moment.
    struct Notice: Equatable { let text: String; let id = UUID() }
    var notice: Notice?
    @ObservationIgnored private var generation = 0

    init(taskId: String, threads: [OrgThread]? = nil) {
        self.taskId = taskId
        self.threads = threads
    }

    func load() async {
        generation += 1
        let gen = generation
        loading = true
        defer { if gen == generation { loading = false } }
        do {
            let list = try await WalnutAPI().orgThreads(taskId: taskId)
            guard gen == generation else { return }
            threads = list
            error = nil
        } catch {
            guard gen == generation else { return }
            if let api = error as? APIError, api.isCancelled { return }
            self.error = threads == nil ? "Couldn't load the threads. Pull to try again." : "Couldn't refresh the threads."
            AppLog.warn("org", "threads load failed", ["taskId": taskId, "error": error.localizedDescription])
        }
    }

    /// One action on a thread. A failure leaves the thread as it was and says so.
    func edit(_ threadId: String, _ edit: OrgThreadEdit) async {
        busyThreadId = threadId
        defer { busyThreadId = nil }
        do {
            try await WalnutAPI().editOrgThread(taskId: taskId, threadId: threadId, edit)
            error = nil
        } catch {
            self.error = "Couldn't update the thread. Try again."
            AppLog.warn("org", "thread edit failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            await load()
            return
        }
        await load()
        tellWhereItWent(threadId)
    }

    private func tellWhereItWent(_ threadId: String) {
        if let text = OrgThreadModel.movedNotice(threadId, threads: threads ?? [], now: Date().addingTimeInterval(AppClock.demoOffset)) {
            notice = Notice(text: text)
        }
    }

    /// A Follow up into the node's chat, filed under the thread. True when the server took it.
    func followUp(_ threadId: String, sessionId: String, text: String) async -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return false }
        busyThreadId = threadId
        defer { busyThreadId = nil }
        do {
            _ = try await WalnutAPI().sendThreadFollowUp(
                sessionId: sessionId, threadId: threadId, text: words, messageId: SendRetryPolicy.newMessageId())
        } catch {
            AppLog.warn("org", "thread follow-up failed", ["taskId": taskId, "threadId": threadId, "error": error.localizedDescription])
            return false
        }
        followUpSentAt[threadId] = Date()
        await load()
        tellWhereItWent(threadId)
        return true
    }
}
