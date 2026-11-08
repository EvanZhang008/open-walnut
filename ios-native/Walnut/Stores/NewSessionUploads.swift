import Foundation
import CryptoKit
import Observation

/// What the first message of a session that does not exist yet carries
/// (`NewSessionChatView`): its photos and files, uploaded with no session
/// (`UploadTarget.unbound`) before the create call, each with its own progress
/// and failure. The server takes them on to the session's host itself.
///
/// Photos go as pictures: the create call takes words only, so each photo is
/// uploaded like a file and named under the pictures header
/// (`ComposerFile.imagesHeaderLine`), the way a session's own photos reach it.
/// A photo keeps one upload id for as long as the app runs (`photoCopy`), so
/// sending it again resumes on the host or is answered with the finished file
/// instead of leaving a second copy there.
@MainActor
@Observable
final class NewSessionUploads {
    struct Item: Identifiable, Equatable {
        let file: ComposerFile
        /// A picked photo, sent as a picture and drawn as one, not as a card.
        let isPhoto: Bool
        var id: String { file.id }
    }

    private(set) var items: [Item] = []
    /// Bytes the host holds of each, by upload id: a send again resumes there.
    private(set) var held: [String: Int64] = [:]
    /// The one whose upload ended the last attempt.
    private(set) var failedID: String?
    private(set) var running = false
    /// The page was left: nothing more goes up, and no session is made.
    private(set) var abandoned = false

    @ObservationIgnored private let transport: SessionUploadTransport

    /// Each photo's copy, by its JPEG's digest.
    private static var photoCopies: [String: ComposerFile] = [:]

    init(transport: SessionUploadTransport? = nil) {
        self.transport = transport ?? WalnutAPI()
    }

    var files: [ComposerFile] { items.filter { !$0.isPhoto }.map(\.file) }
    var isEmpty: Bool { items.isEmpty }

    /// What this launch carries: the photos, each made a file once, then the files.
    func prepare(images: [SelectedImage], files: [ComposerFile]) async throws {
        var photos: [Item] = []
        for image in images {
            photos.append(Item(file: try await Self.photoCopy(image.jpegData), isPhoto: true))
        }
        items = photos + files.map { Item(file: $0, isPhoto: false) }
        held = held.filter { entry in items.contains { $0.id == entry.key } }
        failedID = nil
        abandoned = false
    }

    /// The photo's file, the same one (and so the same upload id) every time
    /// these bytes are sent in this run of the app.
    static func photoCopy(_ jpeg: Data) async throws -> ComposerFile {
        let digest = SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined()
        if let kept = photoCopies[digest], FileManager.default.fileExists(atPath: kept.localURL.path) { return kept }
        // A name of its own: the server's picture lane keeps the file on the host
        // under its name, beside other sessions' pictures.
        let file = try await ComposerFileStore.importData(jpeg, name: "photo-\(digest.prefix(12)).jpg")
        photoCopies[digest] = file
        return file
    }

    /// The pairing is going (`LocalDataReset`): no photo keeps the upload id it
    /// had with the old server. The copies themselves go with the composer
    /// store's (`ComposerFileStore.removeAll`).
    static func forgetPhotoCopies() {
        photoCopies = [:]
    }

    /// Each one's path on the machine Walnut runs on, in order, uploaded from
    /// where its copy there stands, pictures and files apart. One already up
    /// answers its path again without its bytes. The one that fails is `failedID`.
    func upload() async throws -> (imagePaths: [String], filePaths: [String]) {
        running = true
        failedID = nil
        defer { running = false }
        var images: [String] = []
        var files: [String] = []
        for item in items {
            guard !abandoned else { throw CancellationError() }
            let id = item.id
            let watch = UUID()
            FileSendFlights.watch(id, by: watch) { [weak self] bytes in self?.held[id] = bytes }
            defer { FileSendFlights.unwatch(id, by: watch) }
            do {
                let path = try await FileSendFlights.resumedPath(
                    for: item.file, target: .unbound, transport: transport, held: held[id] ?? 0)
                held[id] = item.file.size
                if item.isPhoto { images.append(path) } else { files.append(path) }
            } catch {
                if !abandoned { failedID = id }
                throw error
            }
        }
        guard !abandoned else { throw CancellationError() }
        return (images, files)
    }

    /// The cards the launching page draws, one per file; photos are drawn as
    /// pictures above them. `failed`: the last attempt ended, so each card says
    /// how far it got and offers Retry and Remove.
    func chips(failed: Bool) -> [TimelineFileChip] {
        items.filter { !$0.isPhoto }.map {
            TimelineFileChip.local($0.file, held: held[$0.id], pending: !failed, failed: failed,
                                   failedHere: $0.id == failedID)
        }
    }

    /// Drop one file (its card's Remove): its copy on the phone goes.
    func remove(_ id: String) {
        guard let item = items.first(where: { $0.id == id }) else { return }
        items.removeAll { $0.id == id }
        held[id] = nil
        if failedID == id { failedID = nil }
        FileSendFlights.forget(id)
        ComposerFileStore.remove(item.file)
        if item.isPhoto { Self.photoCopies = Self.photoCopies.filter { $0.value.id != id } }
    }

    /// The page was left mid-launch: the upload running now stops (what the host
    /// has stays, so a later send resumes there), and no session is made.
    func abandon() {
        abandoned = true
        for item in items where FileSendFlights.knownPath(item.id) == nil { FileSendFlights.cancelUpload(item.id) }
    }

    /// The launch no longer carries these (they went back to the composer): the
    /// copies stay, for that composer's next send.
    func release() {
        items = []
        failedID = nil
    }

    /// The server holds them all now: the phone's copies go.
    func finish() {
        for item in items {
            FileSendFlights.forget(item.id)
            ComposerFileStore.remove(item.file)
            if item.isPhoto { Self.photoCopies = Self.photoCopies.filter { $0.value.id != item.id } }
        }
        items = []
        held = [:]
        failedID = nil
    }
}
