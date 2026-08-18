import AVFoundation
import XCTest
@testable import Walnut

/// Audio-session activation failures → user-facing message + retry policy.
///
/// Field incident 2026-08-18 (build 45): the user pressed the mic twice, one
/// second apart, and both presses failed with
/// `NSOSStatusErrorDomain 561017449` at stage `session-activate`. The screen
/// said "Recording failed: NSOSStatusErrorDomain 561017449 — The operation
/// couldn't be completed." — unactionable. 561017449 is FourCC `'!pri'` =
/// `AVAudioSession.ErrorCode.insufficientPriority`: per the SDK header
/// (CoreAudioTypes/AudioSessionTypes.h) "the app was not allowed to set the
/// audio category because another app (Phone, etc.) is controlling it".
///
/// Why these tests are the acceptance criteria: the iOS Simulator implements no
/// audio arbitration, so NO simulator or CI run can produce '!pri', '!int', or
/// 'siri'. The mapping is therefore split into a pure type and pinned here.
final class VoiceSessionDiagnosisTests: XCTestCase {

    private func osStatus(_ code: Int) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: code)
    }

    // MARK: - The exact field failure

    /// Regression pin for the incident. The literal 561017449 is spelled out on
    /// purpose: this test must fail if the enum-to-message wiring ever drifts,
    /// even if the symbol name still looks right.
    func testFieldCodeIsInsufficientPriorityNotCannotInterruptOthers() {
        XCTAssertEqual(AVAudioSession.ErrorCode.insufficientPriority.rawValue, 561_017_449,
                       "the code seen in the field is '!pri'")
        XCTAssertEqual(AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue, 560_557_684,
                       "'!int' is a DIFFERENT code — 560557684, not the field one")
        XCTAssertEqual(VoiceSessionDiagnosis.fourCC(561_017_449), "!pri")
        XCTAssertEqual(VoiceSessionDiagnosis.fourCC(560_557_684), "!int")
    }

    func testInsufficientPriorityGetsPlainLanguageAndIsRetryable() {
        let d = VoiceSessionDiagnosis.classify(osStatus(561_017_449))

        XCTAssertEqual(d.reason, "insufficient-priority")
        XCTAssertEqual(d.message, "Another app is using audio (a call?) — end it and try again")
        XCTAssertTrue(d.retryable, "a call ending frees the category")
        XCTAssertFalse(d.tryBareConfig, "our options were fine; another app simply outranked us")
    }

    /// The user-visible half of the bug: no OSStatus, no domain, no "error".
    func testContentionMessagesLeakNoDiagnosticJargon() {
        let contention = [
            AVAudioSession.ErrorCode.insufficientPriority.rawValue,
            AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue,
            AVAudioSession.ErrorCode.siriIsRecording.rawValue,
            AVAudioSession.ErrorCode.isBusy.rawValue,
            AVAudioSession.ErrorCode.cannotStartRecording.rawValue,
            AVAudioSession.ErrorCode.mediaServicesFailed.rawValue,
        ]
        for code in contention {
            let message = VoiceSessionDiagnosis.classify(osStatus(code)).message
            XCTAssertFalse(message.contains("NSOSStatus"), "leaks a domain: \(message)")
            XCTAssertFalse(message.contains("\(code)"), "leaks the OSStatus: \(message)")
            XCTAssertFalse(message.lowercased().contains("error"), "jargon: \(message)")
            XCTAssertTrue(message.lowercased().contains("try again"),
                          "a recoverable failure must tell the user what to do: \(message)")
        }
    }

    // MARK: - Per-code policy

    func testCannotInterruptOthersIsTheBackgroundCase() {
        let d = VoiceSessionDiagnosis.classify(osStatus(AVAudioSession.ErrorCode.cannotInterruptOthers.rawValue))
        XCTAssertEqual(d.reason, "cannot-interrupt-others")
        XCTAssertTrue(d.retryable)
        XCTAssertTrue(d.message.contains("another app"), d.message)
    }

    func testSiriIsRecordingIsRetryable() {
        let d = VoiceSessionDiagnosis.classify(osStatus(AVAudioSession.ErrorCode.siriIsRecording.rawValue))
        XCTAssertEqual(d.reason, "siri-recording")
        XCTAssertTrue(d.retryable, "Siri releases the mic on its own")
        XCTAssertTrue(d.message.contains("Siri"), d.message)
    }

    func testIsBusyStaysRetryable() {
        let d = VoiceSessionDiagnosis.classify(osStatus(AVAudioSession.ErrorCode.isBusy.rawValue))
        XCTAssertEqual(d.reason, "busy")
        XCTAssertTrue(d.retryable, "pre-fix behavior for '!act' must not regress")
    }

    /// No input hardware: waiting is pointless and a "try again" would lie.
    func testResourceNotAvailableIsTerminalAndSaysSo() {
        let d = VoiceSessionDiagnosis.classify(osStatus(AVAudioSession.ErrorCode.resourceNotAvailable.rawValue))
        XCTAssertEqual(d.reason, "resource-unavailable")
        XCTAssertFalse(d.retryable)
        XCTAssertFalse(d.tryBareConfig)
        XCTAssertFalse(d.message.lowercased().contains("try again"),
                       "must not promise a retry that cannot work: \(d.message)")
    }

    /// -50 and '!cat' mean WE sent something illegal — change the request
    /// (bare config) rather than repeating it or waiting.
    func testOurOwnConfigErrorsAskForTheBareConfigNotAWait() {
        for code in [AVAudioSession.ErrorCode.badParam.rawValue,
                     AVAudioSession.ErrorCode.incompatibleCategory.rawValue] {
            let d = VoiceSessionDiagnosis.classify(osStatus(code))
            XCTAssertTrue(d.tryBareConfig, "code \(code) should drop to the barest legal combo")
            XCTAssertFalse(d.retryable, "code \(code): identical retry is pointless")
        }
    }

    func testBadParamKeepsItsNegativeCodeClassified() {
        // -50 is not a FourCC; it must still classify (regression guard for a
        // fourCC-first implementation that would drop it into .unknown).
        let d = VoiceSessionDiagnosis.classify(osStatus(-50))
        XCTAssertEqual(d.reason, "bad-param")
        XCTAssertNil(VoiceSessionDiagnosis.fourCC(-50), "-50 has no printable FourCC")
    }

    // MARK: - Unknown failures keep their evidence

    func testUnrecognizedOSStatusKeepsRawDiagnostics() {
        let d = VoiceSessionDiagnosis.classify(osStatus(123_456))
        XCTAssertEqual(d.reason, "unclassified")
        XCTAssertTrue(d.message.contains("123456"),
                      "an unknown failure's only evidence is the raw code: \(d.message)")
        XCTAssertTrue(d.message.contains(NSOSStatusErrorDomain), d.message)
    }

    func testNonOSStatusDomainIsUnclassified() {
        let d = VoiceSessionDiagnosis.classify(NSError(domain: "com.example.other", code: 7))
        XCTAssertEqual(d.reason, "unclassified")
        XCTAssertTrue(d.message.contains("com.example.other"), d.message)
    }

    // MARK: - Retry cadence

    /// The pre-fix bug in numbers: the old loop slept 150ms after failure #0
    /// only, so three activations completed inside ~150ms. Every failed attempt
    /// must now buy real time.
    func testEveryRetryWaitsAndTheBudgetIsBounded() {
        XCTAssertEqual(VoiceSessionDiagnosis.maxAttempts, 3)
        XCTAssertEqual(VoiceSessionDiagnosis.backoff(afterAttempt: 0), 300)
        XCTAssertEqual(VoiceSessionDiagnosis.backoff(afterAttempt: 1), 500)
        XCTAssertNil(VoiceSessionDiagnosis.backoff(afterAttempt: 2), "attempts are spent")
        XCTAssertNil(VoiceSessionDiagnosis.backoff(afterAttempt: 99))

        let total = VoiceSessionDiagnosis.backoffMs.reduce(0, +)
        XCTAssertGreaterThanOrEqual(total, 500, "must actually outlast a transient hold")
        XCTAssertLessThanOrEqual(total, 1_500, "a failing mic press must stay responsive")
    }

    func testBackoffRejectsNegativeAttempt() {
        XCTAssertNil(VoiceSessionDiagnosis.backoff(afterAttempt: -1))
    }

    // MARK: - FourCC rendering

    func testFourCCRendersPrintableCodesAndRejectsTheRest() {
        XCTAssertEqual(VoiceSessionDiagnosis.fourCC(AVAudioSession.ErrorCode.isBusy.rawValue), "!act")
        XCTAssertEqual(VoiceSessionDiagnosis.fourCC(AVAudioSession.ErrorCode.siriIsRecording.rawValue), "siri")
        XCTAssertEqual(VoiceSessionDiagnosis.fourCC(AVAudioSession.ErrorCode.mediaServicesFailed.rawValue), "msrv")
        XCTAssertNil(VoiceSessionDiagnosis.fourCC(0), "zero is not a FourCC")
        XCTAssertNil(VoiceSessionDiagnosis.fourCC(1), "non-printable bytes must not become mojibake")
    }

    // MARK: - Failure envelope

    /// `start()` logs from this envelope, so the trail it carries is the
    /// difference between "561017449 again" and "which branch, after how many
    /// attempts, on which call".
    func testActivationFailureCarriesTheDiagnosticTrail() {
        let underlying = osStatus(561_017_449)
        let failure = VoiceSessionActivationFailure(
            underlying: underlying,
            diagnosis: .classify(underlying),
            attempts: 3,
            stage: "set-active"
        )
        XCTAssertEqual(failure.diagnosis.reason, "insufficient-priority")
        XCTAssertEqual(failure.attempts, 3)
        XCTAssertEqual(failure.stage, "set-active")
        XCTAssertEqual(failure.underlying.code, 561_017_449)
    }
}
