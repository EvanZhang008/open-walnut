import CoreLocation
import XCTest
@testable import Walnut

/// A Core Location stand-in that records every call the recorder makes and answers
/// each location question the way a user who allows it would.
final class RecordingLocationManager: PlacesLocationManaging {
    var authorizationStatus: CLAuthorizationStatus
    var accuracyAuthorization: CLAccuracyAuthorization = .fullAccuracy
    /// The status a question leaves behind (nil: no answer, the status stays).
    var answerToWhenInUse: CLAuthorizationStatus? = .authorizedWhenInUse
    var answerToAlways: CLAuthorizationStatus? = .authorizedAlways
    private(set) var whenInUseQuestions = 0
    private(set) var alwaysQuestions = 0
    private(set) var monitoringStarts = 0

    init(status: CLAuthorizationStatus) { authorizationStatus = status }

    func requestWhenInUseAuthorization() {
        whenInUseQuestions += 1
        if let answerToWhenInUse { authorizationStatus = answerToWhenInUse }
    }

    func requestAlwaysAuthorization() {
        alwaysQuestions += 1
        if let answerToAlways { authorizationStatus = answerToAlways }
    }

    func startMonitoringVisits() { monitoringStarts += 1 }
    func stopMonitoringVisits() {}
}

/// The demo asks iOS for no location access and records no visits, checked by what
/// the recorder and the chat's Places prompt DO, on every way in: Turn On (the
/// Places screen and its Allow Always button), the Always question owed when Walnut
/// is open again or access changes, visit monitoring on the return to the
/// foreground, and the prompt an agent's Places read raises in a conversation.
/// Each has a control outside the demo, so a test that cannot fail shows up as a
/// failing control (App Store gate r8 on r11: n22, n23, n26 and n27 survived a
/// source-text scan).
///
/// The controls write the real app's two Places preferences; setUp keeps them and
/// tearDown puts them back. Everything in the demo lands in the demo's own suite.
@MainActor
final class PlacesDemoBehaviorTests: XCTestCase {
    private var savedURL: URL?
    private var savedToken: String?
    private var savedReal: [String: Any] = [:]
    private static let realKeys = [PlacesSettings.enabledKey, PlacesSettings.askedAlwaysKey]

    override func setUp() async throws {
        savedURL = AppConfig.processServerURLOverride
        savedToken = AppConfig.processTokenOverride
        savedReal = [:]
        for key in Self.realKeys {
            if let value = UserDefaults.standard.object(forKey: key) { savedReal[key] = value }
        }
        AppPrefs.eraseDemo()
    }

    override func tearDown() async throws {
        AppConfig.processServerURLOverride = savedURL
        AppConfig.processTokenOverride = savedToken
        AppPrefs.eraseDemo()
        for key in Self.realKeys {
            if let value = savedReal[key] {
                UserDefaults.standard.set(value, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }

    private func enterDemo() {
        AppConfig.processServerURLOverride = DemoMode.baseURL
        AppConfig.processTokenOverride = DemoMode.token
        XCTAssertTrue(DemoMode.isActive)
    }

    /// Paired with a (made up) real server: the controls.
    private func pairReal() {
        AppConfig.processServerURLOverride = URL(string: "https://walnut-places.invalid")!
        AppConfig.processTokenOverride = "places-test-token"
        XCTAssertFalse(DemoMode.isActive)
    }

    // MARK: - Turn On (the Places screen's Turn On and Allow Always)

    func testTurnOnInTheDemoPutsNoLocationQuestion() async {
        enterDemo()
        for status in [CLAuthorizationStatus.notDetermined, .authorizedWhenInUse] {
            let location = RecordingLocationManager(status: status)
            let recorder = PlacesRecorder(manager: location)
            await recorder.turnOn()
            XCTAssertEqual(location.whenInUseQuestions, 0, "\(status.rawValue): the demo asked iOS for While Using")
            XCTAssertEqual(location.alwaysQuestions, 0, "\(status.rawValue): the demo asked iOS for Always")
            XCTAssertEqual(location.monitoringStarts, 0, "\(status.rawValue): the demo started visit monitoring")
            XCTAssertTrue(PlacesSettings.isEnabled, "the demo's own switch is on")
            XCTAssertFalse(PlacesSettings.askedAlways, "the Always question was not used up")
            recorder.turnOff()
        }
    }

    /// Control: the same Turn On outside the demo asks for While Using, then Always,
    /// and starts recording once Always is given.
    func testTurnOnOutsideTheDemoAsksIOSAndRecords() async {
        pairReal()
        let location = RecordingLocationManager(status: .notDetermined)
        let recorder = PlacesRecorder(manager: location)
        await recorder.turnOn()
        XCTAssertEqual(location.whenInUseQuestions, 1)
        XCTAssertEqual(location.alwaysQuestions, 1)
        XCTAssertEqual(location.monitoringStarts, 1)
        recorder.turnOff()
    }

    // MARK: - The Always question owed (the return to the foreground, an access change)

    func testTheAlwaysQuestionOwedWhileTheDemoIsOnIsNotPut() async {
        enterDemo()
        PlacesSettings.isEnabled = true
        PlacesSettings.askedAlways = false
        let location = RecordingLocationManager(status: .authorizedWhenInUse)
        let recorder = PlacesRecorder(manager: location)
        recorder.oweAlwaysForTesting()
        await recorder.askAlwaysIfOwed()?.value
        XCTAssertEqual(location.alwaysQuestions, 0, "the demo asked iOS for Always")
        XCTAssertFalse(PlacesSettings.askedAlways, "the Always question was not used up")
    }

    /// Control: owed outside the demo, the same call puts it once.
    func testTheAlwaysQuestionOwedOutsideTheDemoIsPut() async {
        pairReal()
        PlacesSettings.isEnabled = true
        PlacesSettings.askedAlways = false
        let location = RecordingLocationManager(status: .authorizedWhenInUse)
        let recorder = PlacesRecorder(manager: location)
        recorder.oweAlwaysForTesting()
        await recorder.askAlwaysIfOwed()?.value
        XCTAssertEqual(location.alwaysQuestions, 1)
        XCTAssertTrue(PlacesSettings.askedAlways)
    }

    // MARK: - Visit monitoring on the return to the foreground

    func testTheDemoStartsNoVisitMonitoringWithAlwaysGiven() {
        enterDemo()
        PlacesSettings.isEnabled = true
        let location = RecordingLocationManager(status: .authorizedAlways)
        let recorder = PlacesRecorder(manager: location)
        recorder.becameActive()
        XCTAssertEqual(location.monitoringStarts, 0, "the demo started visit monitoring")
        XCTAssertFalse(recorder.monitoring)
        XCTAssertEqual(location.alwaysQuestions + location.whenInUseQuestions, 0)
    }

    /// Control: outside the demo, the return to the foreground starts it.
    func testTheReturnToTheForegroundStartsVisitMonitoringOutsideTheDemo() {
        pairReal()
        PlacesSettings.isEnabled = true
        let location = RecordingLocationManager(status: .authorizedAlways)
        let recorder = PlacesRecorder(manager: location)
        recorder.becameActive()
        XCTAssertEqual(location.monitoringStarts, 1)
        XCTAssertTrue(recorder.monitoring)
        recorder.turnOff()
    }

    // MARK: - The chat's Places prompt (an agent reads Places in a conversation)

    func testTheChatsPlacesPromptDoesNothingInTheDemo() {
        enterDemo()
        let state = PlacesAccessPrompt.shared.currentState()
        XCTAssertFalse(state.available, "the demo's prompt is available")
        XCTAssertEqual(PlacesAccessDecision.decide(state), .nothing)
    }

    /// Control: with a real pairing and Places off, the prompt offers to turn it on.
    func testTheChatsPlacesPromptOffersPlacesWithARealPairing() {
        pairReal()
        PlacesSettings.isEnabled = false
        let state = PlacesAccessPrompt.shared.currentState()
        XCTAssertTrue(state.available)
        XCTAssertEqual(PlacesAccessDecision.decide(state), .offerTurnOn)
    }
}
