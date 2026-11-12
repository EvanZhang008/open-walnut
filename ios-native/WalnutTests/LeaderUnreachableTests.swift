import XCTest
@testable import Walnut

/// A Walnut server is the leader (the Mac) or a replica; the cloud companion is just a
/// replica that runs on the cloud. Two things follow for the phone:
///
///  - It reads what the server says it is (`role`, `placement`, `serverCapabilities`,
///    `leader`) and falls back to the frozen `mode` / `cloud` / `bridgeHosts` only for an
///    older server. A host replica used to read as "Mac unknown" for good, since only the
///    companion sends `bridgeHosts`.
///  - Every refusal that means "this needs your Mac and it is not answering" is one check
///    (`APIError.isLeaderUnreachableForNow` / `isLeaderUnreachable`): a host replica's
///    `needs_leader` meets the same retry and words as the companion's older codes, and
///    those words never say "cloud" for it.
@MainActor
final class LeaderUnreachableTests: XCTestCase {

    // MARK: - Server facts on /status

    private func decode(_ json: String) throws -> ServerStatus {
        try JSONDecoder().decode(ServerStatus.self, from: Data(json.utf8))
    }

    func testStatusDecodesTheServerFacts() throws {
        let s = try decode(#"""
        {"mode":"REPLICA","cloud":false,"version":"1","serverTime":"t","capabilities":["asks"],
         "role":"replica","placement":"host","serverCapabilities":["backup-leader"],
         "leader":{"answers":false,"why":"link-down","since":1700000000000}}
        """#)
        XCTAssertEqual(s.role, .replica)
        XCTAssertEqual(s.placement, .host)
        XCTAssertEqual(s.serverCapabilities, ["backup-leader"])
        XCTAssertEqual(s.leader, .init(answers: false, why: "link-down", since: 1_700_000_000_000))
        XCTAssertTrue(s.isReplica)
        XCTAssertFalse(s.isOnCloud)
        XCTAssertEqual(s.hasCapability("backup-leader"), true)
        XCTAssertEqual(s.hasCapability("public-door"), false)
        XCTAssertEqual(s.leaderReach, .offline)
    }

    /// An older server sends none of them; a newer one may word them differently. Neither
    /// fails the probe (a failed probe takes the app offline).
    func testServerFactsAreLenient() throws {
        let old = try decode(#"{"mode":"REPLICA","cloud":true,"version":"0.9","serverTime":"t"}"#)
        XCTAssertNil(old.role)
        XCTAssertNil(old.placement)
        XCTAssertNil(old.serverCapabilities)
        XCTAssertNil(old.leader)
        XCTAssertNil(old.hasCapability("public-door"), "a server that lists nothing cannot answer")
        XCTAssertTrue(old.isReplica, "falls back to mode")
        XCTAssertTrue(old.isOnCloud, "falls back to cloud")

        let odd = try decode(#"""
        {"mode":"LIVE","cloud":false,"version":"9","serverTime":"t","role":"witness","placement":"moon",
         "serverCapabilities":"public-door","leader":{"why":"x"}}
        """#)
        XCTAssertNil(odd.role)
        XCTAssertNil(odd.placement)
        XCTAssertNil(odd.serverCapabilities)
        XCTAssertNil(odd.leader, "a leader without answers says nothing")
        XCTAssertFalse(odd.isReplica)

        let roundTrip = try JSONDecoder().decode(ServerStatus.self, from: JSONEncoder().encode(
            try decode(#"{"mode":"REPLICA","cloud":true,"version":"1","serverTime":"t","role":"replica","placement":"cloud","leader":{"answers":true}}"#)
        ))
        XCTAssertEqual(roundTrip.placement, .cloud)
        XCTAssertEqual(roundTrip.leader?.answers, true)
    }

    /// `role` and `placement` win over `mode` and `cloud` when the server sends them.
    func testRoleAndPlacementWinOverTheFrozenFields() {
        let s = ServerStatus(mode: .live, cloud: true, version: "1", serverTime: "", role: .replica, placement: .host)
        XCTAssertTrue(s.isReplica)
        XCTAssertFalse(s.isOnCloud)
        let leader = ServerStatus(mode: .replica, cloud: false, version: "1", serverTime: "", role: .leader, placement: .mac)
        XCTAssertFalse(leader.isReplica)
    }

    /// `leader.answers` wins over the companion's bridge list; a replica that has not
    /// heard yet falls back to it rather than claiming the Mac is gone.
    func testLeaderReachReadsLeaderAnswersFirst() {
        func status(_ leader: ServerStatus.LeaderPresence?, bridges: [String]?) -> ServerStatus {
            ServerStatus(mode: .replica, cloud: true, version: "1", serverTime: "",
                         bridgeHosts: bridges?.map { .init(hostAlias: $0, since: nil) }, leader: leader)
        }
        XCTAssertEqual(status(.init(answers: true), bridges: nil).leaderReach, .reachable)
        XCTAssertEqual(status(.init(answers: true), bridges: []).leaderReach, .reachable)
        XCTAssertEqual(status(.init(answers: false, why: "link-down"), bridges: ["__local__"]).leaderReach, .offline)
        XCTAssertEqual(status(.init(answers: false, why: "not-heard"), bridges: ["__local__"]).leaderReach, .reachable)
        XCTAssertEqual(status(.init(answers: false, why: "not-heard"), bridges: nil).leaderReach, .unknown)
        XCTAssertEqual(status(nil, bridges: nil).leaderReach, .unknown)
        XCTAssertEqual(status(nil, bridges: []).leaderReach, .offline)
    }

    // MARK: - Composer provenance on a host replica

    private func hostReplica(answers: Bool?) -> ServerStatus {
        ServerStatus(mode: .replica, cloud: false, version: "1", serverTime: "",
                     role: .replica, placement: .host, serverCapabilities: [],
                     leader: answers.map { .init(answers: $0, why: $0 ? "answers" : "link-down") })
    }

    /// The bug: a host replica sends no `bridgeHosts`, so the row always read "Mac unknown".
    func testAHostReplicaWhoseMacAnswersSaysMac() {
        let p = ComposerHostProvenance.chat(status: hostReplica(answers: true), online: true)
        XCTAssertEqual(ComposerHostProvenance.verdict(status: hostReplica(answers: true), online: true), .mac(relayed: true))
        XCTAssertEqual(p.label, "Mac")
        XCTAssertNil(p.detail)
        XCTAssertFalse(p.degraded)
    }

    func testAHostReplicaWithTheMacAwayNeverSaysCloud() {
        let p = ComposerHostProvenance.chat(status: hostReplica(answers: false), online: true)
        XCTAssertEqual(p.label, "Mac offline")
        XCTAssertEqual(p.detail, "Your Mac isn't answering, so new messages can't go out until it's back.")
        XCTAssertEqual(p.icon, "laptopcomputer.slash")
        XCTAssertTrue(p.degraded)

        let down = ComposerHostProvenance.chat(status: hostReplica(answers: false), online: false)
        XCTAssertEqual(down.label, "Offline")
        XCTAssertFalse((down.detail ?? "").lowercased().contains("cloud"), down.detail ?? "")
        XCTAssertEqual(down.icon, "wifi.slash")
    }

    /// A newer companion reports `leader` too: it decides, and the cloud words stay.
    func testACompanionThatReportsLeaderUsesIt() {
        let gone = ServerStatus(mode: .replica, cloud: true, version: "1", serverTime: "",
                                bridgeHosts: [.init(hostAlias: "__local__", since: nil)], cloudChat: .available,
                                role: .replica, placement: .cloud, leader: .init(answers: false, why: "link-down"))
        let p = ComposerHostProvenance.chat(status: gone, online: true)
        XCTAssertEqual(p.label, "Cloud")
        XCTAssertTrue(p.degraded)
        let back = ServerStatus(mode: .replica, cloud: true, version: "1", serverTime: "", bridgeHosts: [],
                                role: .replica, placement: .cloud, leader: .init(answers: true))
        XCTAssertEqual(ComposerHostProvenance.chat(status: back, online: true).label, "Mac")
    }

    /// The leader itself says role leader: "Mac", whatever `mode` an odd build sent.
    func testTheLeaderSaysMac() {
        let mac = ServerStatus(mode: .live, cloud: false, version: "1", serverTime: "",
                               role: .leader, placement: .mac, leader: .init(answers: true, why: "leader"))
        XCTAssertEqual(ComposerHostProvenance.verdict(status: mac, online: true), .mac(relayed: false))
    }

    // MARK: - One check for "the Mac is not answering"

    private func refusal(_ status: Int, _ code: String, _ message: String = "") -> APIError {
        .server(status: status, code: code, message: message, serverHash: nil, serverContent: nil)
    }

    private let needsLeader = "This needs your Mac, which is not answering right now."

    func testTheCodesAreOneClass() {
        for code in ["needs_leader", "bridge_offline", "primary_only", "primary_unreachable"] {
            XCTAssertTrue(refusal(503, code).isLeaderUnreachableForNow, code)
            XCTAssertTrue(refusal(503, code).isLeaderUnreachable, code)
        }
        for code in ["not_supported_cloud", "images_not_supported_cloud"] {
            XCTAssertFalse(refusal(501, code).isLeaderUnreachableForNow, "\(code) never clears by waiting on that box")
            XCTAssertTrue(refusal(501, code).isLeaderUnreachable, code)
        }
        for code in ["not_found", "host_reconnecting", "session_dead", "unavailable"] {
            XCTAssertFalse(refusal(503, code).isLeaderUnreachable, code)
        }
        XCTAssertFalse(refusal(400, "needs_leader").isLeaderUnreachableForNow, "needs_leader is always a 503")
        XCTAssertFalse(APIError.cancelled.isLeaderUnreachable)
        XCTAssertFalse(APIError.isLeaderUnreachableForNow(code: nil))
    }

    /// A host replica's refusal used to be retried only by the file uploader.
    func testNeedsLeaderIsRetriedLikeBridgeOffline() {
        XCTAssertTrue(SendRetryPolicy.isRetryable(refusal(503, "needs_leader", needsLeader)))
        XCTAssertTrue(SendRetryPolicy.isRetryable(refusal(503, "bridge_offline")))
        XCTAssertFalse(SendRetryPolicy.isRetryable(refusal(501, "not_supported_cloud")))
        XCTAssertTrue(SessionFileUploader.clearsOnItsOwn(refusal(503, "needs_leader")))
        XCTAssertTrue(SessionFileUploader.clearsOnItsOwn(refusal(503, "host_reconnecting")))
    }

    /// Every ladder that showed the companion's sentence shows the replica's own for
    /// `needs_leader`, and its stand-in never names the cloud.
    func testNeedsLeaderWordsOnEveryLadder() {
        let e = refusal(503, "needs_leader", needsLeader)
        XCTAssertEqual(BridgeOfflineCopy.message(e), needsLeader)
        XCTAssertEqual(SessionLifecycleController.friendlyError(e), needsLeader)
        XCTAssertEqual(RoutinesView.friendlyError(e), needsLeader)
        XCTAssertEqual(SessionControlsSheet.friendlyControlError(e), needsLeader)
        XCTAssertEqual(NewSessionSheet.createErrorMessage(code: "needs_leader", serverMessage: needsLeader), needsLeader)

        let bare = refusal(503, "needs_leader")
        for words in [BridgeOfflineCopy.message(bare), SessionLifecycleController.friendlyError(bare),
                      NewSessionSheet.createErrorMessage(code: "needs_leader", serverMessage: "  ")] {
            XCTAssertEqual(words, BridgeOfflineCopy.leaderFallback)
            XCTAssertFalse(words.lowercased().contains("cloud"), words)
        }
        XCTAssertEqual(BridgeOfflineCopy.message(refusal(503, "bridge_offline")), BridgeOfflineCopy.fallback,
                       "the companion's stand-in is unchanged")

        let warning = NewSessionSheet.launchOptionsFailure(code: "needs_leader", serverMessage: needsLeader, hasOptions: true)
        XCTAssertEqual(warning.warning, needsLeader, "a doomed Start is warned about, as for bridge_offline")

        XCTAssertEqual(SessionConversationStore.queueFailureText(e), "Can't reach your Mac right now. Try again in a moment.")
        XCTAssertEqual(SessionConversationStore.queueFailureText(refusal(501, "not_supported_cloud")), "Send now needs your Mac online.")
        XCTAssertEqual(SessionConversationStore.stopFailureText(e), "Can't reach your Mac to stop it. Try again in a moment.")
        XCTAssertEqual(ComposerControlsModel.lookup(afterFailing: e), .unreachable)
        XCTAssertEqual(ComposerControlsModel.writeOutcome(for: e), .unreachable)
        XCTAssertEqual(OrgOpenNotice.failure("Growth VP", e), "Growth VP can be started only while your Mac is online.")
        XCTAssertEqual(ContentActionButtons.failureWords("Open", e), "Open works only while your Mac is online.")
    }

    /// A replica refuses `needs_leader` before anything is sent, so Edit stays offered.
    func testALetterReplyRefusedByAReplicaDidNotArrive() {
        let f = LetterReplyStore.failure(refusal(503, "needs_leader", needsLeader))
        XCTAssertFalse(f.mayHaveArrived)
        XCTAssertFalse(f.sentence.lowercased().contains("cloud"), f.sentence)
        XCTAssertEqual(f.sentence, LetterReplyStore.failure(refusal(503, "bridge_offline", "No live bridge to the primary box")).sentence)
    }

    func testThreadsReadsTreatNeedsLeaderLikePrimaryOnly() {
        let words = OrgThreadsStore.readError(hasThreads: true, fromCache: false, cause: refusal(503, "needs_leader", needsLeader))
        XCTAssertEqual(words, "\(needsLeader) The threads shown here have not been refreshed. It will try again automatically.")
    }

    func testSearchSaysItNeedsTheMacForNeedsLeader() async {
        let model = GlobalSearchModel(debounce: .zero) { _ in throw self.refusal(503, "needs_leader", self.needsLeader) }
        model.schedule("walnut")
        let deadline = Date().addingTimeInterval(2)
        while model.unavailableNotice == nil && Date() < deadline { try? await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(model.unavailableNotice, "Search needs your Mac online. Notes search still works.")
        XCTAssertFalse(model.failed)
    }

    // MARK: - Guard: no new ladder branches on a single code

    /// The class guard: the codes of "the Mac is not answering" are named only in the one
    /// helper (and the few sites listed here with why). A new refusal path that matches one
    /// code by hand would miss the others (a host replica's `needs_leader` was missed this
    /// way by every path but the uploader), so it fails here until it reads the helper.
    func testNoRefusalPathNamesALeaderCodeByHand() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Walnut")
        let codes = ["needs_leader", "bridge_offline", "primary_only", "primary_unreachable",
                     "not_supported_cloud", "images_not_supported_cloud"]
        let allowed: [String: Int] = [
            // The helper itself.
            "API/Models.swift": 4,
            // The stand-in sentence picked by code.
            "Core/BridgeOfflineCopy.swift": 1,
            // Images-specific words for a code no current server sends (needs_leader rides
            // the retry ladder above it).
            "Stores/SessionConversationStore.swift": 1,
            // "This cloud companion is too old": a 501 only a pre-2026-08 companion sends.
            "Views/Sessions/NewSessionSheet.swift": 2,
            "Views/Sessions/NewSessionChatView.swift": 1,
            // Calendar create: the message path shows needs_leader's own sentence.
            "Views/Calendar/CalendarCreateSheet.swift": 1,
            // Old isNotSupportedCloud, kept for the Wave 1 contract test.
            "API/ModelsWave1.swift": 1,
        ]
        var found: [String: Int] = [:]
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = files?.nextObject() as? URL {
            guard url.pathExtension == "swift" else { continue }
            let rel = String(url.path.dropFirst(root.path.count + 1))
            let text = try String(contentsOf: url, encoding: .utf8)
            for line in text.split(separator: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.hasPrefix("//") { continue }
                if codes.contains(where: { line.contains("\"\($0)\"") }) { found[rel, default: 0] += 1 }
            }
        }
        XCTAssertFalse(found.isEmpty, "the scan found no Swift sources under \(root.path)")
        XCTAssertEqual(found, allowed, "read APIError.isLeaderUnreachableForNow / isLeaderUnreachable instead")
    }
}
