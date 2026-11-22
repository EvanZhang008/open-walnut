import XCTest
import AVFoundation
import UIKit
@testable import Walnut

/// The composer's own camera (`camera_capture`): which stills of a recording go
/// to the AI (the same rule as the web's `pickStills`), what each file is named,
/// the recording's clock, and the whole flow driven through the fake camera.
///
/// Nothing here opens a camera or a microphone: the flow tests use
/// `FakeCameraSource`. What only a device shows is listed in `LiveCameraSource`.
@MainActor
final class CameraCaptureTests: XCTestCase {

    // MARK: - Which stills

    /// Scores are percents of changed cells: the first sample, then the seven
    /// biggest changes at or over 0.5 %, in time order.
    func testTheFirstSampleAndTheSevenBiggestChangesAreKeptInTimeOrder() {
        let scores: [Double] = [0, 0.2, 3, 0.9, 0.5, 30, 0.1, 1.5, 2, 4, 0.6, 12]
        XCTAssertEqual(VideoStills.select(scores: scores), [0, 2, 3, 5, 7, 8, 9, 11])
    }

    func testASampleUnderTheThresholdIsNeverKept() {
        XCTAssertEqual(VideoStills.select(scores: [0, 0.49, 0.1, 0.3]), [0], "a board that never changed sends one still")
        XCTAssertEqual(VideoStills.select(scores: [40]), [0])
        XCTAssertEqual(VideoStills.select(scores: []), [])
        XCTAssertEqual(VideoStills.select(scores: [0, 0.5, 0.49]), [0, 1], "exactly the threshold is kept")
    }

    func testEqualScoresKeepTheEarlierSample() {
        XCTAssertEqual(VideoStills.select(scores: [0, 9, 9, 9, 9], maxStills: 3), [0, 1, 2])
    }

    /// The score is the percent of cells whose grey moved MORE than 16: a small new
    /// line on a whiteboard counts in full, a camera's noise not at all.
    func testTheScoreIsThePercentOfCellsThatChangedFromThePreviousSample() {
        XCTAssertEqual(VideoStills.score([0, 0, 0, 0], [255, 0, 0, 0]), 25)
        XCTAssertEqual(VideoStills.score([100, 100], [116, 84]), 0, "a move of exactly 16 is noise")
        XCTAssertEqual(VideoStills.score([100, 100], [117, 100]), 50)
        XCTAssertEqual(VideoStills.score([10, 20, 30], [10, 20, 30]), 0)
        XCTAssertEqual(VideoStills.score([], [1]), 0)
        XCTAssertEqual(VideoStills.scores([[0, 0], [100, 0], [100, 50]]), [0, 50, 50])
        // A box drawn over 1 % of a 64 x 36 board is kept; the old mean difference
        // (about 2 of 255 here) was under its threshold of 6 and dropped it.
        let cells = VideoStills.signatureWidth * VideoStills.signatureHeight
        XCTAssertEqual(cells, 2304)
        let before = [UInt8](repeating: 240, count: cells)
        var after = before
        for i in 0..<23 { after[i] = 40 }
        XCTAssertEqual(VideoStills.score(before, after), 23.0 / 2304 * 100, accuracy: 1e-9)
        XCTAssertEqual(VideoStills.select(scores: VideoStills.scores([before, after])), [0, 1])
        // The web's greySignature: Rec. 601 weights, rounded.
        XCTAssertEqual(VideoStills.grey(rgba: [255, 255, 255, 0, 255, 0, 0, 0, 0, 0, 255, 0]), [255, 76, 29])
    }

    func testSamplesAreTakenEveryTwoSecondsFromTheStart() {
        XCTAssertEqual(VideoStills.sampleTimes(durationMs: 5_000), [0, 2_000, 4_000])
        XCTAssertEqual(VideoStills.sampleTimes(durationMs: 4_000), [0, 2_000, 4_000])
        XCTAssertEqual(VideoStills.sampleTimes(durationMs: 0), [0])
        XCTAssertEqual(VideoStills.sampleTimes(durationMs: 60_000).count, 31)
    }

    // MARK: - Names and the clock

    func testAStillIsNamedAfterItsVideoAndItsTime() {
        XCTAssertEqual(VideoStills.stillName(video: "camera-1416.mp4", atMs: 6_000), "camera-1416-still-0m06s.jpg")
        XCTAssertEqual(VideoStills.stillName(video: "camera-1416.mov", atMs: 0), "camera-1416-still-0m00s.jpg")
        XCTAssertEqual(VideoStills.stillName(video: "camera-141605.mov", atMs: 65_000), "camera-141605-still-1m05s.jpg")
    }

    func testAVideoIsNamedForTheTimeItWasTakenAndNeverTwice() throws {
        var parts = DateComponents()
        parts.year = 2026; parts.month = 11; parts.day = 20; parts.hour = 14; parts.minute = 16; parts.second = 5
        let date = try XCTUnwrap(Calendar.current.date(from: parts))
        XCTAssertEqual(CameraClipMaker.videoName(at: date, ext: "mov", taken: []), "camera-141605.mov")
        XCTAssertEqual(CameraClipMaker.videoName(at: date, ext: "mov", taken: ["camera-141605.mov"]), "camera-141605-2.mov")
        XCTAssertEqual(CameraClipMaker.videoName(at: date, ext: "mov", taken: ["camera-141605.mov", "camera-141605-2.mov"]),
                       "camera-141605-3.mov")
    }

    func testTheTimerCountsDownFromFiftySecondsAndStopsAtSixty() {
        XCTAssertEqual(CameraCaptureModel.timerLabel(elapsed: 23.2), "0:23")
        XCTAssertEqual(CameraCaptureModel.timerLabel(elapsed: 49.4), "0:49")
        XCTAssertEqual(CameraCaptureModel.timerLabel(elapsed: 52.2), "0:52 \u{00B7} 8s left")
        XCTAssertEqual(CameraCaptureModel.timerLabel(elapsed: 60), "1:00 \u{00B7} 0s left")
        XCTAssertFalse(CameraCaptureModel.reachedLimit(59.9))
        XCTAssertTrue(CameraCaptureModel.reachedLimit(60))
    }

    func testANarrationFailureSaysWhyInTheCardsWords() {
        let unset = APIError.server(status: 503, code: "stt_unavailable", message: "x", serverHash: nil, serverContent: nil)
        XCTAssertEqual(CameraClipMaker.narrationNote(for: unset), "no narration: speech to text is not set up")
        XCTAssertEqual(CameraClipMaker.narrationNote(for: Deadline.Expired()), "no narration: speech to text took too long")
        XCTAssertEqual(CameraClipMaker.narrationNote(for: URLError(.notConnectedToInternet)), "no narration: speech to text failed")
    }

    // MARK: - From a real file

    /// A generated whiteboard video (the fake camera's) through the real stills
    /// pipeline: AVAssetImageGenerator, the signatures, the pick, the JPEGs.
    func testAGeneratedVideoGivesStillsThatChangeWithTheBoard() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("stills-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("clip.mov")
        try await FakeWhiteboard.writeVideo(to: url, seconds: 8, startStage: 1, mirrored: false)
        let out = try await VideoStills.extract(from: url, videoName: "camera-141605.mov")
        XCTAssertEqual(Double(out.durationMs), 8_000, accuracy: 400)
        XCTAssertGreaterThanOrEqual(out.stills.count, 2, "the board gains boxes, so more than the first sample is kept")
        XCTAssertLessThanOrEqual(out.stills.count, VideoStills.maxStills)
        XCTAssertEqual(out.stills.first?.name, "camera-141605-still-0m00s.jpg")
        XCTAssertEqual(out.stills.map(\.atMs), out.stills.map(\.atMs).sorted())
        let image = try XCTUnwrap(UIImage(data: try XCTUnwrap(out.stills.first?.jpeg)))
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height) * image.scale, CGFloat(VideoStills.longEdge))
        // The fake has no sound track: no narration, and it says so.
        let narration = await CameraClipMaker.narrate(url) { _ in XCTFail("nothing to transcribe"); return "" }
        XCTAssertEqual(narration, .none(note: "no sound recorded"))
    }

    /// The HUD line over the picture, the same words as the web's `addedLabel`.
    func testTheAddedLineNamesWhatThisCameraPutInTheMessage() {
        XCTAssertNil(CameraCaptureModel.addedLabel(photos: 0, videos: 0), "nothing yet, no line")
        XCTAssertEqual(CameraCaptureModel.addedLabel(photos: 1, videos: 0), "1 photo added")
        XCTAssertEqual(CameraCaptureModel.addedLabel(photos: 2, videos: 0), "2 photos added")
        XCTAssertEqual(CameraCaptureModel.addedLabel(photos: 0, videos: 1), "1 video added")
        XCTAssertEqual(CameraCaptureModel.addedLabel(photos: 1, videos: 1), "1 photo and 1 video added")
        XCTAssertEqual(CameraCaptureModel.addedLabel(photos: 3, videos: 2), "3 photos and 2 videos added")
    }

    // MARK: - The flow, on the fake camera

    private func model(_ log: Log, allowsVideo: Bool = true, source: CameraSource? = nil,
                       now: @escaping () -> Date = Date.init) -> CameraCaptureModel {
        var actions = CameraCaptureModel.Actions()
        actions.addPhoto = { _ in
            guard log.takesPhotos else { return false }
            log.photos += 1
            return true
        }
        actions.addClip = { clip in
            guard log.takesClips else { return false }
            log.clips.append(clip)
            return true
        }
        actions.close = { log.closed += 1 }
        actions.narrate = { url in await CameraClipMaker.narrate(url) { _ in "" } }
        return CameraCaptureModel(source: source ?? FakeCameraSource(), allowsVideo: allowsVideo, actions: actions, now: now)
    }

    final class Log {
        var photos = 0
        var clips: [CameraClipMaker.Clip] = []
        var closed = 0
        /// Whether the composer takes a photo (false: its merge refused it).
        var takesPhotos = true
        /// Whether the composer takes a video (false: no room for another file).
        var takesClips = true
        func removeClips() { clips.flatMap(\.files).forEach(ComposerFileStore.remove) }
    }

    /// The shutter puts the photo straight in (no look first, no Send in the
    /// camera); the camera stays open for the next one.
    func testAPhotoGoesStraightIntoTheMessageAndTheCameraStaysOpen() async {
        let log = Log()
        let camera = model(log)
        await camera.appear()
        XCTAssertEqual(camera.stage, .live)
        XCTAssertNil(camera.addedLabel)
        await camera.shutter()
        XCTAssertEqual(log.photos, 1, "added the moment it was taken")
        XCTAssertEqual(camera.stage, .live, "the camera stays open")
        XCTAssertEqual(camera.addedLabel, "1 photo added")
        await camera.shutter()
        XCTAssertEqual(log.photos, 2)
        XCTAssertEqual(camera.addedLabel, "2 photos added")
        XCTAssertEqual(log.closed, 0, "nothing closes or sends the message from here")
        camera.close()
        XCTAssertEqual(log.photos, 2, "closing keeps what was added")
    }

    func testAVideoTakesPhotosWhileItRecordsAndGoesInWithItsStills() async throws {
        let log = Log()
        let camera = model(log)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        XCTAssertEqual(camera.stage, .recording)
        await camera.photoWhileRecording()
        XCTAssertEqual(log.photos, 1, "a photo during the video goes straight in as a photo")
        XCTAssertEqual(camera.stage, .recording, "and the video keeps recording")
        XCTAssertEqual(camera.addedLabel, "1 photo added")
        try await Task.sleep(for: .seconds(3))
        await camera.shutter()
        XCTAssertEqual(camera.stage, .live, "back to the picture for the next one")
        XCTAssertEqual(camera.addedLabel, "1 photo and 1 video added")
        let clip = try XCTUnwrap(log.clips.first, "the video went in by itself, never sent")
        XCTAssertEqual(log.clips.count, 1)
        XCTAssertTrue(clip.video.name.hasPrefix("camera-") && clip.video.name.hasSuffix(".mov"))
        XCTAssertFalse(clip.stills.isEmpty)
        XCTAssertTrue(clip.stills.allSatisfy { $0.clip == .still(videoID: clip.video.id) })
        guard case .video(let ms, nil, let note?) = clip.video.clip else { return XCTFail("not a clip: \(String(describing: clip.video.clip))") }
        XCTAssertGreaterThan(ms, 2_000)
        XCTAssertEqual(note, "no sound recorded")
        log.removeClips()
    }

    /// A video the composer refuses (its file limit) is kept, never lost: no new
    /// recording while it is held, "Add the video" tries again, "Discard it" drops it.
    func testAVideoTheMessageRefusesIsKeptUntilAddedOrDiscarded() async throws {
        let log = Log()
        log.takesClips = false
        let camera = model(log)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1.2))
        await camera.shutter()
        XCTAssertEqual(camera.stage, .notAdded)
        XCTAssertEqual(camera.notice, "This message has no room for another file.")
        let held = try XCTUnwrap(camera.heldClip)
        XCTAssertTrue(FileManager.default.fileExists(atPath: held.video.localURL.path), "its copy is kept")
        XCTAssertNil(camera.addedLabel)
        await camera.shutter()
        XCTAssertEqual(camera.stage, .notAdded, "no new recording while a video is held")
        await camera.addHeldClip()
        XCTAssertEqual(camera.stage, .notAdded, "still refused: still held")
        XCTAssertNotNil(camera.heldClip)
        log.takesClips = true
        await camera.addHeldClip()
        XCTAssertEqual(log.clips.map(\.video.id), [held.video.id])
        XCTAssertNil(camera.heldClip)
        XCTAssertEqual(camera.stage, .live)
        XCTAssertEqual(camera.addedLabel, "1 video added")

        log.takesClips = false
        await camera.shutter()
        try await Task.sleep(for: .seconds(1.2))
        await camera.shutter()
        let second = try XCTUnwrap(camera.heldClip)
        await camera.discardHeldClip()
        XCTAssertNil(camera.heldClip)
        XCTAssertEqual(camera.stage, .live)
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.video.localURL.path), "a discarded video's copy goes")
        XCTAssertEqual(log.clips.count, 1)
        log.removeClips()
    }

    func testClosingDropsAVideoThatWasNotAdded() async throws {
        let log = Log()
        log.takesClips = false
        let camera = model(log)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1.2))
        await camera.shutter()
        let clip = try XCTUnwrap(camera.heldClip)
        camera.close()
        XCTAssertEqual(log.closed, 1)
        XCTAssertTrue(log.clips.isEmpty)
        XCTAssertNil(camera.heldClip)
        XCTAssertFalse(FileManager.default.fileExists(atPath: clip.video.localURL.path), "its copy goes")
    }

    func testAPhotoOverTheCeilingIsRefusedWithASentence() async {
        let log = Log()
        let camera = model(log)
        camera.actions.photoRoom = { 0 }
        await camera.appear()
        await camera.shutter()
        XCTAssertEqual(log.photos, 0)
        XCTAssertEqual(camera.stage, .live, "the camera stays on")
        XCTAssertEqual(camera.notice, "This message already has \(ComposerBar.maxImages) photos.")
        XCTAssertNil(camera.addedLabel)
    }

    func testARefusedPhotoIsNotCountedAsAdded() async {
        let log = Log()
        log.takesPhotos = false
        let camera = model(log)
        await camera.appear()
        await camera.shutter()
        XCTAssertEqual(camera.photosAdded, 0, "a photo the composer refused is not one more added")
        XCTAssertEqual(camera.notice, "The photo was not added.")
        camera.mode = .video
        await camera.shutter()
        await camera.photoWhileRecording()
        XCTAssertEqual(camera.photosAdded, 0, "nor one taken while recording")
        XCTAssertEqual(camera.notice, "The photo was not added.")
        await camera.shutter()
        log.removeClips()
    }

    /// The one-minute stop runs outside the clock it cancels, so the clip is made
    /// whole (its stills and its narration) and goes in by itself.
    func testTheMinuteLimitStopsAndAddsTheWholeVideo() async throws {
        let log = Log()
        var clock = Date()
        let camera = model(log, now: { clock })
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        XCTAssertEqual(camera.stage, .recording)
        try await Task.sleep(for: .seconds(1))
        clock += CameraCaptureModel.maxSeconds + 1
        for _ in 0..<100 where log.clips.isEmpty { try await Task.sleep(for: .milliseconds(100)) }
        let clip = try XCTUnwrap(log.clips.first, "stopped by itself and added")
        XCTAssertEqual(camera.stage, .live)
        XCTAssertFalse(clip.stills.isEmpty)
        guard case .video(_, nil, let note?) = clip.video.clip else { return XCTFail("no narration note") }
        XCTAssertEqual(note, "no sound recorded", "its narration was made, not cut short")
        log.removeClips()
        camera.close()
    }

    /// "Skip the words" while the clip is still being made: the video goes in at
    /// once, its card saying the words were skipped, and nothing is transcribed.
    func testSkippingTheWordsAddsTheVideoWithoutThem() async throws {
        let log = Log()
        let source = CountingSource()
        source.stopDelay = .milliseconds(500)
        let camera = model(log, source: source)
        camera.actions.narrate = { _ in XCTFail("skipped words are not transcribed"); return .said("") }
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1))
        let stopped = Task { await camera.shutter() }
        for _ in 0..<100 where camera.stage == .recording { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(camera.stage, .finishing)
        camera.skipWords()
        await stopped.value
        let clip = try XCTUnwrap(log.clips.first)
        guard case .video(_, nil, let note?) = clip.video.clip else { return XCTFail("no narration note") }
        XCTAssertEqual(note, CameraCaptureModel.wordsSkippedNote)
        XCTAssertEqual(camera.stage, .live)
        log.removeClips()
    }

    /// Leaving the app stops the camera first; the recording ends and goes in,
    /// and the camera starts again on return.
    func testAfterTheAppWasAwayTheVideoIsAddedAndTheCameraStartsAgain() async throws {
        let log = Log()
        let source = CountingSource()
        let camera = model(log, source: source)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1))
        await camera.sceneLeft()
        XCTAssertEqual(source.stops, 1)
        XCTAssertEqual(log.clips.count, 1, "the recording went in")
        XCTAssertEqual(camera.stage, .starting, "no picture while away")
        XCTAssertEqual(source.starts, 1, "nothing starts the camera while away")
        await camera.sceneReturned()
        XCTAssertEqual(source.starts, 2, "started again before the picture is live")
        XCTAssertEqual(camera.stage, .live)
        log.removeClips()
    }

    /// A call takes the camera while it records: the recording ends and goes in,
    /// never left running on a stopped camera.
    func testAnInterruptionWhileRecordingStopsAndAddsTheVideo() async throws {
        let log = Log()
        let source = CountingSource()
        let camera = model(log, source: source)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1))
        source.onInterruption?(.began("The microphone is in use by a call or another app."))
        for _ in 0..<100 where log.clips.isEmpty || camera.notice == nil { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(log.clips.count, 1)
        XCTAssertNotEqual(camera.stage, .recording)
        XCTAssertEqual(camera.notice, "The microphone is in use by a call or another app.")
        log.removeClips()
        camera.close()
    }

    /// Closing while the clip's stills are still being made: they are finished,
    /// and the video goes in without waiting for its words.
    func testClosingWhileTheClipIsMadeStillAddsIt() async throws {
        let log = Log()
        let source = CountingSource()
        source.stopDelay = .milliseconds(500)
        let camera = model(log, source: source)
        camera.actions.narrate = { _ in XCTFail("a closed camera's words are not transcribed"); return .said("") }
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1))
        let made = Task { await camera.shutter() }
        for _ in 0..<100 where camera.stage == .recording { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(camera.stage, .finishing)
        camera.close()
        XCTAssertEqual(log.closed, 1, "the camera goes at once")
        await made.value
        XCTAssertFalse(source.stopCancelled, "closing never cuts the clip's making short")
        let clip = try XCTUnwrap(log.clips.first, "the video still goes in")
        XCTAssertFalse(clip.stills.isEmpty, "with its stills")
        guard case .video(_, nil, let note?) = clip.video.clip else { return XCTFail("no narration note") }
        XCTAssertEqual(note, CameraCaptureModel.wordsSkippedNote)
        XCTAssertNil(camera.heldClip)
        XCTAssertEqual(source.starts, 1, "a closed camera never starts again")
        log.removeClips()
    }

    /// Closing while a stopped video waits for its words: it goes in now,
    /// without them, and their late answer changes nothing.
    func testClosingWhileTheWordsArePendingAddsTheVideoWithoutThem() async throws {
        let log = Log()
        let gate = WordsGate()
        let camera = model(log)
        camera.actions.narrate = { _ in _ = await gate.wait(); return .said("late words") }
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1.2))
        let made = Task { await camera.shutter() }
        for _ in 0..<100 where gate.calls < 1 { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(camera.stage, .finishing, "waiting for its words")
        camera.close()
        await made.value
        let clip = try XCTUnwrap(log.clips.first, "closing never drops a video being finished")
        guard case .video(_, nil, let note?) = clip.video.clip else { return XCTFail("no narration note") }
        XCTAssertEqual(note, CameraCaptureModel.wordsSkippedNote)
        gate.release(1)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(log.clips.count, 1)
        log.removeClips()
    }

    /// Each recording waits for its own words: the late answer of one whose words
    /// were skipped never lands on the next one.
    func testASkippedRecordingsLateWordsNeverLandOnTheNextOne() async throws {
        let log = Log()
        let gate = WordsGate()
        let camera = model(log)
        camera.actions.narrate = { _ in
            let n = await gate.wait()
            return .said(n == 1 ? "first words" : "second words")
        }
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        try await Task.sleep(for: .seconds(1.2))
        let first = Task { await camera.shutter() }
        for _ in 0..<100 where gate.calls < 1 { try await Task.sleep(for: .milliseconds(20)) }
        camera.skipWords()
        await first.value
        XCTAssertEqual(log.clips.count, 1)
        XCTAssertEqual(camera.stage, .live)

        await camera.shutter()
        XCTAssertEqual(camera.stage, .recording, "recording again")
        try await Task.sleep(for: .seconds(1.2))
        let second = Task { await camera.shutter() }
        for _ in 0..<100 where gate.calls < 2 { try await Task.sleep(for: .milliseconds(20)) }
        gate.release(1)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(camera.stage, .finishing, "the first one's late words did not end the second's wait")
        XCTAssertEqual(log.clips.count, 1)
        gate.release(2)
        await second.value
        XCTAssertEqual(log.clips.count, 2)
        guard case .video(_, nil, let skipped?) = log.clips[0].video.clip else { return XCTFail("first: no note") }
        XCTAssertEqual(skipped, CameraCaptureModel.wordsSkippedNote)
        guard case .video(_, let said?, nil) = log.clips[1].video.clip else { return XCTFail("second: no words") }
        XCTAssertEqual(said, "second words")
        log.removeClips()
    }

    /// Stop is never held up by a photo still being taken during the recording.
    func testStopEndsTheRecordingWhileAPhotoIsBeingTaken() async throws {
        let log = Log()
        let source = CountingSource()
        let camera = model(log, source: source)
        await camera.appear()
        camera.mode = .video
        await camera.shutter()
        source.photoDelay = .milliseconds(800)
        let photo = Task { await camera.photoWhileRecording() }
        for _ in 0..<100 where !camera.busy { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(camera.busy, "the photo is being taken")
        await camera.shutter()
        XCTAssertNotEqual(camera.stage, .recording, "the tap on Stop ended the recording")
        XCTAssertEqual(log.clips.count, 1, "and its video went in")
        await photo.value
        XCTAssertEqual(log.photos, 1, "the photo still lands")
        log.removeClips()
        camera.close()
    }

    /// A speech to text whose answers come only when the test lets them, one per
    /// call, and never early on a cancel (a server that answers anyway).
    @MainActor
    final class WordsGate {
        private(set) var calls = 0
        private var waits: [Int: CheckedContinuation<Void, Never>] = [:]
        /// Waits for its release; returns which call it was (1, 2, ...).
        func wait() async -> Int {
            calls += 1
            let n = calls
            await withCheckedContinuation { waits[n] = $0 }
            return n
        }
        func release(_ n: Int) { waits.removeValue(forKey: n)?.resume() }
    }

    /// The fake camera, counting its starts and stops.
    @MainActor
    final class CountingSource: CameraSource {
        private let fake = FakeCameraSource()
        var starts = 0
        var stops = 0
        /// How long a stop takes to hand over its file, and a photo to come.
        var stopDelay: Duration = .zero
        var photoDelay: Duration = .zero
        /// The stop's wait was cancelled (the clip was dropped while it was made).
        var stopCancelled = false
        var onInterruption: ((CameraInterruption) -> Void)?
        var previewView: UIView { fake.previewView }
        var canFlip: Bool { fake.canFlip }
        var position: AVCaptureDevice.Position { fake.position }
        func start() async throws { starts += 1; try await fake.start() }
        func stop() { stops += 1; fake.stop() }
        func flip() async throws { try await fake.flip() }
        func takePhoto() async throws -> UIImage {
            try await Task.sleep(for: photoDelay)
            return try await fake.takePhoto()
        }
        func startRecording(to url: URL, sound: Bool) async throws -> Bool { try await fake.startRecording(to: url, sound: sound) }
        func stopRecording() async throws -> URL {
            do { try await Task.sleep(for: stopDelay) } catch { stopCancelled = true; throw error }
            return try await fake.stopRecording()
        }
    }
}
