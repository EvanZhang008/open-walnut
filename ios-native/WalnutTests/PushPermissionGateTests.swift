import Foundation
import UserNotifications
import XCTest
@testable import Walnut

/// The notification permission prompt (and the APNs registration) only happen
/// when the paired server reports `apns.configured: true`. A server that cannot
/// send, one that cannot be reached, and the demo never cause a prompt; a held
/// ask runs again on the next foreground.
@MainActor
final class PushPermissionGateTests: XCTestCase {
    /// Counts the iOS calls instead of making them.
    @MainActor
    final class FakeSystem: PushSystem {
        var status: UNAuthorizationStatus = .notDetermined
        var grant = true
        private(set) var prompts = 0
        private(set) var registrations = 0
        private(set) var unregistrations = 0

        func authorizationStatus() async -> UNAuthorizationStatus { status }

        func requestAuthorization() async throws -> Bool {
            prompts += 1
            status = grant ? .authorized : .denied
            return grant
        }

        func registerForRemoteNotifications() { registrations += 1 }

        func unregisterForRemoteNotifications() { unregistrations += 1 }
    }

    enum Answer {
        case configured(Bool)
        case unreachable
    }

    private var savedURL: URL?
    private var savedToken: String?

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        // A paired phone on an ordinary (non-demo) server.
        AppConfig.processServerURLOverride = URL(string: "https://walnut.example.net")
        AppConfig.processTokenOverride = "token"
    }

    override func tearDown() async throws {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
    }

    private final class Box { var answer: Answer; var asked = 0; init(_ a: Answer) { answer = a } }

    private func registration(_ box: Box, system: FakeSystem) -> PushRegistration {
        PushRegistration(system: system, fetchStatus: {
            box.asked += 1
            switch box.answer {
            case .configured(let value):
                return WalnutAPI.PushStatus(
                    registeredThisDevice: false, registered: false, count: 0,
                    apns: WalnutAPI.APNsStatus(configured: value), tokens: []
                )
            case .unreachable:
                throw APIError.network(underlying: URLError(.notConnectedToInternet))
            }
        })
    }

    // The phone of someone whose server HAS the key: unchanged behavior.
    func testServerThatCanSendGetsThePromptAndTheRegistration() async {
        let system = FakeSystem()
        let push = registration(Box(.configured(true)), system: system)
        await push.requestPermissionAndRegister()
        XCTAssertEqual(system.prompts, 1)
        XCTAssertEqual(system.registrations, 1)
        XCTAssertEqual(push.serverSendAnswer, .canSend)
        XCTAssertFalse(push.deferredUntilServerCanSend)
    }

    func testServerThatCannotSendGetsNoPrompt() async {
        let system = FakeSystem()
        let box = Box(.configured(false))
        let push = registration(box, system: system)
        await push.requestPermissionAndRegister()
        XCTAssertEqual(system.prompts, 0, "no prompt for notifications that cannot arrive")
        XCTAssertEqual(system.registrations, 0)
        XCTAssertEqual(push.serverSendAnswer, .cannotSend)
        XCTAssertTrue(push.deferredUntilServerCanSend)

        // The next foreground asks the server again; still no key, still no prompt.
        await push.retryDeferred()
        XCTAssertEqual(system.prompts, 0)
        XCTAssertEqual(box.asked, 2)

        // Someone adds the APNs key on the server: the next foreground asks.
        box.answer = .configured(true)
        await push.retryDeferred()
        XCTAssertEqual(system.prompts, 1)
        XCTAssertEqual(system.registrations, 1)
        XCTAssertFalse(push.deferredUntilServerCanSend)
    }

    func testUnreachableServerGetsNoPrompt() async {
        let system = FakeSystem()
        let box = Box(.unreachable)
        let push = registration(box, system: system)
        await push.requestPermissionAndRegister()
        XCTAssertEqual(system.prompts, 0)
        XCTAssertEqual(system.registrations, 0)
        XCTAssertEqual(push.serverSendAnswer, .unreachable)
        XCTAssertTrue(push.deferredUntilServerCanSend, "tried again on the next foreground")
    }

    func testAlreadyGrantedPhoneOnlyRegistersWhenTheServerCanSend() async {
        let system = FakeSystem()
        system.status = .authorized
        let box = Box(.configured(false))
        let push = registration(box, system: system)
        await push.refreshAuthorization()
        XCTAssertEqual(system.registrations, 0, "no token for a server that cannot send")
        XCTAssertTrue(push.deferredUntilServerCanSend)

        box.answer = .configured(true)
        await push.retryDeferred()
        XCTAssertEqual(system.registrations, 1)
        XCTAssertEqual(system.prompts, 0, "registration never prompts")
    }

    func testDeniedIsNeverAskedAgain() async {
        let system = FakeSystem()
        system.status = .denied
        let box = Box(.configured(true))
        let push = registration(box, system: system)
        await push.requestPermissionAndRegister()
        XCTAssertEqual(system.prompts, 0)
        XCTAssertEqual(box.asked, 0, "denied is decided before the server is asked")
    }

    func testTheDemoNeverPromptsOrRegisters() async {
        AppConfig.processServerURLOverride = DemoMode.baseURL
        let system = FakeSystem()
        system.status = .notDetermined
        let box = Box(.configured(true))
        let push = registration(box, system: system)
        await push.requestPermissionAndRegister()
        XCTAssertEqual(system.prompts, 0)
        XCTAssertEqual(system.registrations, 0)
        XCTAssertEqual(box.asked, 0)

        system.status = .authorized
        await push.refreshAuthorization()
        XCTAssertEqual(system.registrations, 0, "no remote notification registration in the demo")
        XCTAssertFalse(push.deferredUntilServerCanSend, "nothing is held for later either")
        push.recheckOnForeground()
        XCTAssertEqual(system.prompts, 0)
    }

    func testStatusAnswerIsReadFromApnsConfigured() {
        func status(_ configured: Bool?) -> WalnutAPI.PushStatus {
            WalnutAPI.PushStatus(
                registeredThisDevice: nil, registered: nil, count: nil,
                apns: configured.map { WalnutAPI.APNsStatus(configured: $0) }, tokens: nil
            )
        }
        XCTAssertEqual(PushRegistration.sendAnswer(for: status(true)), .canSend)
        XCTAssertEqual(PushRegistration.sendAnswer(for: status(false)), .cannotSend)
        XCTAssertEqual(PushRegistration.sendAnswer(for: status(nil)), .cannotSend)
    }
}
