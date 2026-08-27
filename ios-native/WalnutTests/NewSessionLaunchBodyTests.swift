import XCTest
@testable import Walnut

/// The create call the chat-shaped launcher makes, and the directory listing it
/// ranks against.
///
/// The bug class: a session that silently launches somewhere other than where the
/// user pointed it. `cwd` and `host` are the two fields that decide which machine
/// and which folder the CLI wakes up in, and `201` means ACCEPTED not spawned, so
/// a wrong value here does not fail loudly: it becomes an opaque session error
/// minutes later. Each assertion pins one field's spelling on the wire.
final class NewSessionLaunchBodyTests: XCTestCase {

    private func body(
        cwd: String = "/Users/x/walnut", host: String? = nil, message: String = "hi",
        taskId: String? = nil, mode: String? = nil, model: String? = nil
    ) -> WalnutAPI.CreateSessionBody {
        WalnutAPI.createSessionBody(
            cwd: cwd, host: host, message: message, taskId: taskId, mode: mode, model: model
        )
    }

    // MARK: - cwd + host

    /// The picked folder rides verbatim: no trimming, no normalization the server
    /// didn't ask for.
    func testCwdRidesVerbatim() {
        XCTAssertEqual(body(cwd: "/Users/x/my project").cwd, "/Users/x/my project",
                       "a folder name with a space is a real path, not input to sanitize")
    }

    /// Local is expressed as ABSENT, not "". Both mean the primary box to the
    /// server, and one spelling keeps the "which machine" question single-valued.
    func testLocalHostIsOmittedRatherThanSentAsEmptyString() {
        XCTAssertNil(body(host: "").host)
        XCTAssertNil(body(host: nil).host)
    }

    func testRemoteHostAliasIsSentAsGiven() {
        XCTAssertEqual(body(host: "clouddev").host, "clouddev")
    }

    // MARK: - model

    /// The model the launcher picked must actually reach the server, or the
    /// session silently runs on the default and the pill lied at launch time.
    func testPickedModelRidesTheCreateCall() {
        XCTAssertEqual(body(model: "opus").model, "opus")
        XCTAssertEqual(body(model: "global.anthropic.claude-sonnet-5").model,
                       "global.anthropic.claude-sonnet-5")
    }

    /// "default" is the catalog's no-op row and nil is "server decides": both must
    /// omit the key so an old server behaves exactly as it did before the field.
    func testDefaultAndEmptyModelsAreOmitted() {
        XCTAssertNil(body(model: nil).model)
        XCTAssertNil(body(model: "").model)
        XCTAssertNil(body(model: "default").model, "'default' is the no-op row, not a model id")
    }

    // MARK: - mode

    /// bypass is the server's own default, so the launcher sends nil for it (the
    /// caller's rule); an explicitly chosen non-default mode must ride.
    func testExplicitModeRidesAndCallerCanOmitTheDefault() {
        XCTAssertEqual(body(mode: "plan").mode, "plan")
        XCTAssertNil(body(mode: nil).mode)
    }

    // MARK: - Encoded shape

    /// Omission must be real omission in JSON, not `null`: the server's validator
    /// reads absent and null the same way today, but a present-null key is a
    /// promise this client shouldn't make.
    func testOmittedFieldsEncodeAsAbsentKeys() throws {
        let encoded = try JSONEncoder().encode(body(host: "", mode: nil, model: "default"))
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertEqual(object["cwd"] as? String, "/Users/x/walnut")
        XCTAssertNil(object["host"], "local must not appear as a host key at all")
        XCTAssertNil(object["model"])
        XCTAssertNil(object["mode"])
        XCTAssertNil(object["taskId"])
    }

    /// A task-linked launch keeps its link (the sheet path still uses this).
    func testTaskIdRidesWhenLinking() {
        XCTAssertEqual(body(taskId: "task-7").taskId, "task-7")
    }

    // MARK: - DirListing decoding

    /// `exists: false` still arrives as HTTP 200 (the listed directory is absent),
    /// which the picker must be able to read rather than treating as an error.
    func testDirListingDecodesTheAbsentDirectoryCase() throws {
        let json = #"{"dirs":[],"parent":"/Users/x","exists":false}"#
        let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
        XCTAssertFalse(listing.exists)
        XCTAssertEqual(listing.parent, "/Users/x")
        XCTAssertTrue(listing.dirs.isEmpty)
    }

    /// An older server omits `exists`. Defaulting to false would make every
    /// listing look like a missing directory, so it defaults to true.
    func testDirListingDefaultsExistsToTrueWhenTheServerOmitsIt() throws {
        let json = #"{"dirs":["/Users/x/a"],"parent":"/Users/x"}"#
        let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
        XCTAssertTrue(listing.exists)
        XCTAssertEqual(listing.dirs, ["/Users/x/a"])
    }

    /// A malformed listing degrades to empty instead of throwing: the picker's
    /// whole point is that a failed listing never blocks a typed path.
    func testDirListingDegradesRatherThanThrowing() throws {
        let json = #"{"dirs":"nope","parent":null}"#
        let listing = try JSONDecoder().decode(DirListing.self, from: Data(json.utf8))
        XCTAssertTrue(listing.dirs.isEmpty)
        XCTAssertEqual(listing.parent, "")
        XCTAssertTrue(listing.exists)
    }

    // MARK: - Chip identity across the launcher

    /// The launcher's "is this the folder I already picked" check must agree with
    /// the web's chip identity, including the wire's "" vs the ranker's nil.
    func testQuickFolderIdentityMatchesTheWebChipKey() {
        let wire = SessionLaunchOptions.Dir(
            cwd: "/Users/x/walnut", host: "", hostLabel: nil,
            lastUsed: "2026-08-27T00:00:00Z", count: 3
        )
        XCTAssertEqual(
            PathRanking.pathChipKey(dir: wire),
            PathRanking.pathChipKey(cwd: "/Users/x/walnut", host: nil),
            "an empty-string host and a nil host are the same machine"
        )
        let remote = SessionLaunchOptions.Dir(
            cwd: "/workspace", host: "clouddev", hostLabel: "Big box",
            lastUsed: "2026-08-27T00:00:00Z", count: 1
        )
        XCTAssertEqual(PathRanking.pathChipKey(dir: remote), "clouddev::/workspace")
    }

    /// The launch bar's folder label is the web's pathLabel: basename, plus the
    /// host when remote, and an explicit prompt when nothing is chosen.
    func testLaunchBarFolderLabelMatchesTheWebPathLabel() {
        XCTAssertEqual(PathRanking.pathLabel(cwd: "", host: nil, hostLabel: nil), "Choose folder…")
        XCTAssertEqual(PathRanking.pathLabel(cwd: "/Users/x/walnut", host: nil, hostLabel: nil), "walnut")
        XCTAssertEqual(
            PathRanking.pathLabel(cwd: "/workspace/proj", host: "clouddev", hostLabel: "Big box"),
            "proj · Big box"
        )
    }
}
