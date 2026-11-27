import AVFoundation
import XCTest

@testable import Walnut

/// THE APP MAKES NO SOUND WHERE A TEST OR AN AGENT RUNS IT (2026-11-08: a test run on a
/// Mac with a person at it woke its built-in speaker; a Simulator plays through the Mac).
/// Every site that can open audio hardware checks `AudioSilence.isOn`: tests/ios/audio-silence-sites.test.ts.
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

    func testThisProcessIsSilent() {
        XCTAssertTrue(AudioSilence.isOn, "a hosted unit test runs under XCTest")
    }

    /// A silent take writes a real recording with no audio hardware: a readable CAF in the
    /// recorder's format, as long as the take, all zeros.
    func testASilentTakeWritesASilentRecordingAsLongAsTheTake() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("silent-take-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let capture = try XCTUnwrap(SilentVoiceCapture(url: url))
        // Talk and hands-free voice mode read a running take's level: true silence, never
        // nil (nil reads as a take cut off under them).
        XCTAssertEqual((capture as AudioLevelSource).level, -160)
        Thread.sleep(forTimeInterval: 0.7)
        capture.stop()
        let length = capture.currentTime
        XCTAssertGreaterThanOrEqual(length, 0.7)
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatInt16, interleaved: true)
        XCTAssertEqual(file.fileFormat.sampleRate, 16_000)
        XCTAssertEqual(file.fileFormat.channelCount, 1)
        let seconds = try XCTUnwrap(AudioSilence.seconds(of: url))
        XCTAssertEqual(seconds, length, accuracy: 0.01)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let samples = UnsafeBufferPointer(start: buffer.int16ChannelData?[0], count: Int(buffer.frameLength))
        XCTAssertTrue(samples.allSatisfy { $0 == 0 })
        capture.stop()
        XCTAssertEqual(capture.currentTime, length, "a second stop moves nothing")
    }

    func testASilentStandInLastsAboutAsLongAsTheRealThing() {
        XCTAssertNil(AudioSilence.seconds(of: URL(fileURLWithPath: "/nonexistent/take.caf")))
        XCTAssertEqual(AudioSilence.speechSeconds("hi"), 0.5)
        XCTAssertEqual(AudioSilence.speechSeconds(String(repeating: "a", count: 50)), 3, accuracy: 0.001)
        XCTAssertEqual(AudioSilence.speechSeconds(String(repeating: "a", count: 5_000)), 8)
    }
}
