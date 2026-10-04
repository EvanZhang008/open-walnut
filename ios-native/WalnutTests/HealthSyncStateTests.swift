import XCTest
@testable import Walnut

/// The saved sync state: survives a restart, and an erase cannot be undone by a
/// run that was in flight.
final class HealthSyncStateTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("health-state-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testStateSurvivesARestartAndIsProtectedAndNotBackedUp() throws {
        let file = directory.appendingPathComponent("WalnutHealth/sync-state.json")
        let store = HealthSyncStateStore(fileURL: file)
        store.update { snapshot in
            snapshot.storeId = "hs-1"
            snapshot.anchors["sleep"] = Data([1, 2, 3])
            snapshot.characteristicUUIDs["BloodType"] = "char-bloodtype-2"
        }
        store.flush()
        let reloaded = HealthSyncStateStore(fileURL: file).read()
        XCTAssertEqual(reloaded.storeId, "hs-1")
        XCTAssertEqual(reloaded.anchors["sleep"], Data([1, 2, 3]))
        XCTAssertEqual(reloaded.characteristicUUIDs["BloodType"], "char-bloodtype-2")

        let values = try file.deletingLastPathComponent().resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true, "health anchors never go to iCloud backup")
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        if let protection = attributes[.protectionKey] as? FileProtectionType {
            // The simulator reports no protection class; a device must.
            XCTAssertEqual(protection, .completeUntilFirstUserAuthentication)
        }
    }

    func testEraseRemovesTheFileAndRefusesStaleWrites() throws {
        let file = directory.appendingPathComponent("WalnutHealth/sync-state.json")
        let store = HealthSyncStateStore(fileURL: file)
        let generation = store.generation
        store.update(generation: generation) { $0.anchors["sleep"] = Data([9]) }
        store.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))

        store.eraseAll()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(store.update(generation: generation) { $0.anchors["sleep"] = Data([9]) },
                       "a run from before the erase cannot write its anchors back")
        XCTAssertNil(store.read().anchors["sleep"])
        XCTAssertTrue(store.update(generation: store.generation) { $0.storeId = "hs-2" })
    }

    func testAnUnreadableFileBlocksWritesAndIsReadAgainLater() throws {
        // Stands in for a protected file before the first unlock: the path
        // exists but cannot be read as a file.
        let file = directory.appendingPathComponent("WalnutHealth/sync-state.json")
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: true)
        let store = HealthSyncStateStore(fileURL: file)
        XCTAssertFalse(store.isReadable)
        XCTAssertFalse(store.update { $0.storeId = "hs-scratch" }, "never overwrite anchors it could not read")

        // "Unlocked": the real file is readable now, and the same store reads it.
        try FileManager.default.removeItem(at: file)
        let saved = HealthSyncStateStore(fileURL: file)
        saved.update { $0.anchors["sleep"] = Data([7]) }
        saved.flush()
        XCTAssertTrue(store.isReadable)
        XCTAssertEqual(store.read().anchors["sleep"], Data([7]))
    }

    func testANewStoreKeepsOnlyTheInstallId() {
        var snapshot = HealthSyncSnapshot()
        snapshot.installId = "install"
        snapshot.storeId = "hs-1"
        snapshot.anchors["sleep"] = Data([1])
        snapshot.primed = ["sleep"]
        snapshot.completed = ["sleep"]
        snapshot.characteristicUUIDs["BloodType"] = "char-bloodtype-1"
        snapshot.reset(storeId: "hs-2")
        XCTAssertEqual(snapshot.installId, "install")
        XCTAssertEqual(snapshot.storeId, "hs-2")
        XCTAssertTrue(snapshot.anchors.isEmpty)
        XCTAssertTrue(snapshot.primed.isEmpty)
        XCTAssertTrue(snapshot.completed.isEmpty)
        XCTAssertTrue(snapshot.characteristicUUIDs.isEmpty)
    }
}
