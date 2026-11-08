import XCTest

@testable import Walnut

/// THE APP MAKES NO SOUND WHERE A TEST OR AN AGENT RUNS IT (2026-11-08: a test run on a
/// Mac with a person at it woke its built-in speaker; a Simulator plays through the Mac).
/// Every sound site reading `AudioSilence` is pinned by tests/web/automation-silence.test.ts.
final class AudioSilenceTests: XCTestCase {
    private func defaults(_ values: [String: Any] = [:]) -> UserDefaults {
        let name = "AudioSilenceTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        for (k, v) in values { d.set(v, forKey: k) }
        return d
    }

    func testSilentInTheSimulatorUnlessAPersonAllowsSound() {
        XCTAssertTrue(AudioSilence.decide(defaults: defaults(), environment: [:], simulator: true))
        XCTAssertFalse(AudioSilence.decide(
            defaults: defaults([AudioSilence.allowArgument: true]), environment: [:], simulator: true))
    }

    func testADeviceKeepsItsSound() {
        XCTAssertFalse(AudioSilence.decide(defaults: defaults(), environment: [:], simulator: false))
    }

    func testTestsAreSilentAnywhere() {
        XCTAssertTrue(AudioSilence.decide(
            defaults: defaults([AudioSilence.silentArgument: true]), environment: [:], simulator: false))
        XCTAssertTrue(AudioSilence.decide(
            defaults: defaults(), environment: ["XCTestConfigurationFilePath": "/x"], simulator: false))
        XCTAssertTrue(AudioSilence.decide(
            defaults: defaults(), environment: ["WALNUT_SILENT_AUDIO": "1"], simulator: false))
        // The silent argument wins over a person's allow: a UI test never plays.
        XCTAssertTrue(AudioSilence.decide(
            defaults: defaults([AudioSilence.silentArgument: true, AudioSilence.allowArgument: true]),
            environment: [:], simulator: true))
    }

    func testThisProcessIsSilentAndPlaysAtZero() {
        XCTAssertTrue(AudioSilence.isOn, "a hosted unit test runs under XCTest")
        XCTAssertEqual(AudioSilence.volume(0.6), 0)
    }
}
