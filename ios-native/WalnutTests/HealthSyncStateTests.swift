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
            snapshot.characteristicUUIDs["BloodType"] = "char-bloodtype-h00"
        }
        store.flush()
        let reloaded = HealthSyncStateStore(fileURL: file).read()
        XCTAssertEqual(reloaded.storeId, "hs-1")
        XCTAssertEqual(reloaded.anchors["sleep"], Data([1, 2, 3]))
        XCTAssertEqual(reloaded.characteristicUUIDs["BloodType"], "char-bloodtype-h00")

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

    /// r7b: an r7 file kept the characteristic salt next to the fingerprints.
    /// The first read rewrites the file without it, at once; the fingerprints stay,
    /// so the next send of each characteristic deletes its old row.
    func testAnR7FileLosesItsSaltOnTheFirstRead() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("salt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("health-sync.json")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var old = HealthSyncSnapshot()
        old.characteristicUUIDs = ["DateOfBirth": "char-dateofbirth-h0123456789abcdef0123456789abcdef"]
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        let r7Salt = Data(repeating: 7, count: 32)
        json[HealthSyncStateStore.droppedSaltKey] = r7Salt.base64EncodedString()
        try JSONSerialization.data(withJSONObject: json).write(to: url)
        XCTAssertTrue(HealthSyncStateStore.hasSaltKey(try Data(contentsOf: url)))

        let store = HealthSyncStateStore(fileURL: url)
        XCTAssertEqual(store.read().characteristicUUIDs["DateOfBirth"],
                       "char-dateofbirth-h0123456789abcdef0123456789abcdef", "the fingerprint stays")
        let onDisk = try Data(contentsOf: url)
        XCTAssertFalse(HealthSyncStateStore.hasSaltKey(onDisk), "rewritten at once, before any flush")
        XCTAssertFalse(String(decoding: onDisk, as: UTF8.self).contains(r7Salt.base64EncodedString()))
    }

    /// F2 (2026-10-07 gate): an r6 file kept characteristic values in its keys
    /// (`char-dateofbirth-19800412`). The first read drops them and rewrites the
    /// file at once, before any run, and remembers only the names.
    func testAPreR7FileLosesItsValueBearingKeysOnTheFirstRead() throws {
        let file = directory.appendingPathComponent("WalnutHealth/sync-state.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var old = HealthSyncSnapshot()
        old.storeId = "hs-1"
        old.anchors["sleep"] = Data([1])
        old.characteristicUUIDs = ["DateOfBirth": "char-dateofbirth-19800412", "BloodType": "char-bloodtype-2",
                                   "BiologicalSex": "char-biologicalsex-h0123"]
        try JSONEncoder().encode(old).write(to: file)
        XCTAssertTrue(try String(contentsOf: file, encoding: .utf8).contains("19800412"))

        let migrated = HealthSyncStateStore(fileURL: file).read()
        XCTAssertNil(migrated.characteristicUUIDs["DateOfBirth"])
        XCTAssertNil(migrated.characteristicUUIDs["BloodType"])
        XCTAssertEqual(migrated.characteristicUUIDs["BiologicalSex"], "char-biologicalsex-h0123", "an opaque key stays")
        XCTAssertEqual(migrated.legacyCharacteristicNames, ["DateOfBirth", "BloodType"])
        XCTAssertEqual(migrated.anchors["sleep"], Data([1]), "the rest of the progress is kept")

        let onDisk = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(onDisk.contains("19800412"), "written at once, not at the next flush")
        XCTAssertFalse(onDisk.contains("char-bloodtype-2"))
        XCTAssertEqual(HealthSyncStateStore(fileURL: file).read().legacyCharacteristicNames, ["DateOfBirth", "BloodType"])
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
