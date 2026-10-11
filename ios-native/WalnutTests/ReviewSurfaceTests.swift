import XCTest
@testable import Walnut

/// What App Review reads, pinned in the source: the privacy policy link on the
/// pairing screen and in Settings, one consent sentence for Apple Health and
/// Places everywhere it is asked, a privacy manifest that collects nothing, the
/// send button's spoken name, and the demo's New Session defaults.
final class ReviewSurfaceTests: XCTestCase {
    private let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    private func source(_ path: String) throws -> String {
        try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
    }

    // MARK: - Privacy policy (guideline 5.1.1)

    func testThePrivacyPolicyLinkOpensThePublishedPolicy() throws {
        XCTAssertEqual(PrivacyPolicy.url.absoluteString,
                       "https://github.com/EvanZhang008/open-walnut/blob/main/PRIVACY.md")
        XCTAssertEqual(PrivacyPolicy.title, "Privacy Policy")
        // A `Link` hands the address to iOS (Safari), never to the app's own
        // networking, so the demo's in-process server cannot refuse it.
        XCTAssertTrue(try source("Walnut/Core/PrivacyPolicy.swift").contains("Link(destination: PrivacyPolicy.url)"))
    }

    func testThePairingScreenShowsTheLinkUnderTryTheDemo() throws {
        let setup = try source("Walnut/Views/SetupView.swift")
        let demo = try XCTUnwrap(setup.range(of: "DemoEntryButton(disabled: busy)"))
        let link = try XCTUnwrap(setup.range(of: "PrivacyPolicyLink()"))
        XCTAssertLessThan(demo.lowerBound, link.lowerBound, "the policy link is not under Try the demo")
    }

    func testSettingsAboutHasAPrivacyPolicyRowInAndOutOfTheDemo() throws {
        let settings = try source("Walnut/Views/Settings/SettingsView.swift")
        let about = try XCTUnwrap(settings.range(of: "private var aboutSection: some View {"))
        let body = settings[about.upperBound...].prefix(600)
        XCTAssertTrue(body.contains("Link(destination: PrivacyPolicy.url)"))
        XCTAssertTrue(body.contains("Text(\"About\")"))
        // The About section is outside every demo-only condition: the list's last row.
        _ = try XCTUnwrap(settings.range(of: "                aboutSection\n            }"),
                          "the About section moved inside a condition")
    }

    // MARK: - Consent (guideline 5.1.2)

    /// F3 (2026-10-07 gate): the user's own Walnut server, on a Mac or a cloud
    /// machine they run, then the AI provider it uses; never "only your Mac".
    static let consent = ConsentCopy.destination

    func testTheConsentNamesTheUsersOwnServerNotOnlyAMac() {
        XCTAssertEqual(ConsentCopy.destination,
                       "only to your own Walnut server, on your Mac or on a cloud machine you run, and from there to the AI provider that server uses")
        XCTAssertTrue(ConsentCopy.health.hasSuffix(ConsentCopy.destination + "."))
        XCTAssertTrue(ConsentCopy.places.contains("Apple Maps names each place."))
    }

    func testEveryHealthAndPlacesConsentSaysWhereTheDataGoes() throws {
        let places = try source("Walnut/Places/PlacesAccessPrompt.swift")
        let health = try source("Walnut/Health/HealthAccessPrompt.swift")
        let healthView = try source("Walnut/Views/Settings/AppleHealthView.swift")
        let placesView = try source("Walnut/Views/Settings/PlacesView.swift")
        for (name, text, uses) in [("PlacesAccessPrompt", places, "ConsentCopy.places"),
                                   ("HealthAccessPrompt", health, "ConsentCopy.health"),
                                   ("AppleHealthView", healthView, "ConsentCopy.health"),
                                   ("PlacesView", placesView, "ConsentCopy.destination")] {
            XCTAssertTrue(text.contains(uses), "\(name) does not say where the data goes")
            XCTAssertFalse(text.contains("nowhere else"), "\(name) claims nowhere else")
            XCTAssertFalse(text.contains("only to your Mac"), "\(name) says only your Mac")
            XCTAssertFalse(text.contains("your Mac uses"), "\(name) says the AI provider your Mac uses")
        }
        XCTAssertTrue(ConsentCopy.places.contains("Apple Maps"), "the Places offer does not say Apple Maps names places")
        XCTAssertTrue(placesView.contains("Apple Maps"))
    }

    func testTheUsageStringsSayTheSame() throws {
        // project.yml is what xcodegen writes into Info.plist; the tracked
        // Info.plist must carry the same strings.
        let plistURL = root.appendingPathComponent("Walnut/Support/Info.plist")
        let plist = try XCTUnwrap(NSDictionary(contentsOf: plistURL) as? [String: Any])
        let yml = try source("project.yml")
        for key in ["NSHealthShareUsageDescription", "NSLocationWhenInUseUsageDescription",
                    "NSLocationAlwaysAndWhenInUseUsageDescription"] {
            let value = try XCTUnwrap(plist[key] as? String, key)
            XCTAssertTrue(value.contains(Self.consent), "\(key): \(value)")
            XCTAssertTrue(yml.contains("\(key): \(value)"), "\(key): Info.plist and project.yml differ")
            XCTAssertFalse(value.contains("only on your own Mac"))
            XCTAssertFalse(value.contains("only to your Mac"), "\(key) says only your Mac")
            if key.hasPrefix("NSLocation") {
                XCTAssertTrue(value.contains("Apple Maps"), "\(key) does not say Apple Maps names places")
            }
        }
    }

    // MARK: - Privacy manifest

    func testThePrivacyManifestCollectsNothingAndKeepsItsReasons() throws {
        let url = root.appendingPathComponent("Walnut/Support/PrivacyInfo.xcprivacy")
        let manifest = try XCTUnwrap(NSDictionary(contentsOf: url) as? [String: Any])
        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyTrackingDomains"] as? [Any])?.count, 0)
        // "Data Not Collected": the app sends data only to the user's own server.
        XCTAssertEqual((manifest["NSPrivacyCollectedDataTypes"] as? [Any])?.count, 0)
        let apis = (manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]]) ?? []
        let reasons = Dictionary(uniqueKeysWithValues: apis.map {
            ($0["NSPrivacyAccessedAPIType"] as? String ?? "", $0["NSPrivacyAccessedAPITypeReasons"] as? [String] ?? [])
        })
        XCTAssertEqual(reasons["NSPrivacyAccessedAPICategoryUserDefaults"], ["CA92.1"])
        XCTAssertEqual(reasons["NSPrivacyAccessedAPICategoryFileTimestamp"], ["C617.1"])
        XCTAssertEqual(reasons["NSPrivacyAccessedAPICategorySystemBootTime"], ["35F9.1"])
    }

    // MARK: - VoiceOver

    func testTheSendButtonsAreNamedSend() throws {
        let composer = try source("Walnut/Views/Chat/ComposerView.swift")
        let send = try XCTUnwrap(composer.range(of: "private var sendButton: some View {"))
        XCTAssertTrue(composer[send.upperBound...].prefix(700).contains(".accessibilityLabel(\"Send\")"),
                      "VoiceOver reads the chat send arrow as Up")
        XCTAssertTrue(composer.contains(".accessibilityLabel(quickAction.autoSendArmed ? \"Send\" : \"Stop Recording\")"))
        XCTAssertTrue(try source("Walnut/Views/Inbox/LetterReaderView.swift").contains(".accessibilityLabel(\"Send\")"))
    }

    // MARK: - Demo New Session

    func testTheDemoOpensNewSessionWithNoFolderAndTheDefaultMode() {
        let demo = NewSessionChatView.draftStart(inDemo: true)
        XCTAssertFalse(demo.preselectFolder)
        XCTAssertEqual(demo.mode, .default)
        let real = NewSessionChatView.draftStart(inDemo: false)
        XCTAssertTrue(real.preselectFolder)
        XCTAssertEqual(real.mode, .bypass)
    }

    // MARK: - Voice retention (PRIVACY.md, "Voice recordings waiting to be transcribed")

    /// The policy says a take kept for retry goes after 7 days, at most 20, and
    /// the next time the app starts or records: the limits, and the launch prune.
    func testAVoiceTakeKeptForRetryGoesAfterSevenDaysAndAtLaunch() throws {
        XCTAssertEqual(VoiceRecordingStore.maxAge, 7 * 24 * 3600)
        XCTAssertEqual(VoiceRecordingStore.maxCount, 20)
        let delegate = try source("Walnut/App/QuickActionDelegate.swift")
        XCTAssertTrue(delegate.contains("VoiceRecordingStore.pruneAtLaunch(protectedDataAvailable: application.isProtectedDataAvailable)"),
                      "no prune at launch: a take older than 7 days stays until the next recording")
    }
    // MARK: - Gate r4 (2026-10-07), turned around by the upload refusal (2026-10-10)

    /// The App Store app only reads Apple Health; only the DEBUG seeder asks to
    /// write. The write string still ships in every configuration. Gate r4 (F16)
    /// had Release delete it in a build step, and on 2026-10-10 Apple refused
    /// build 107 at upload: "Missing purpose string in Info.plist ... should
    /// contain a NSHealthUpdateUsageDescription key". The validator asks for it
    /// whenever the binary calls `HKHealthStore.requestAuthorization(toShare:read:)`,
    /// which is also the only way to ask to read.
    func testEveryBuildKeepsTheHealthWriteString() throws {
        let wording = "Only Walnut's test builds add sample health data, to check that syncing works. The App Store version never changes your Apple Health data."
        let yml = try source("project.yml")
        // No step deletes or rewrites the key: project.yml names it once, as the
        // Info.plist property, and nowhere else (a script would have to name it).
        let named = yml.split(separator: "\n").filter { $0.contains("NSHealthUpdateUsageDescription") }
        XCTAssertEqual(named.map { $0.trimmingCharacters(in: .whitespaces) },
                       ["NSHealthUpdateUsageDescription: " + wording],
                       "project.yml names the Health write string outside its Info.plist properties")
        XCTAssertFalse(yml.contains("Delete :NSHealthUpdateUsageDescription"))
        XCTAssertFalse(yml.contains("Release drops the Health write string"))
        // The committed Info.plist carries it too, with the same words.
        let plist = try XCTUnwrap(NSDictionary(contentsOf: root.appendingPathComponent("Walnut/Support/Info.plist")) as? [String: Any])
        XCTAssertEqual(plist["NSHealthUpdateUsageDescription"] as? String, wording)
        XCTAssertNotNil(plist["NSHealthShareUsageDescription"] as? String)
        XCTAssertTrue(try source("Walnut/Health/HealthDebugSeed.swift").hasPrefix("#if DEBUG"))
        // Every other authorization request asks to share nothing.
        let dir = root.appendingPathComponent("Walnut")
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        var asks = 0
        for file in files where file.lastPathComponent != "HealthDebugSeed.swift" {
            let text = try String(contentsOf: file, encoding: .utf8)
            for line in text.split(separator: "\n") where line.contains("requestAuthorization(toShare:") {
                asks += 1
                XCTAssertTrue(line.contains("toShare: []"), "\(file.lastPathComponent) asks to write: \(line)")
            }
        }
        XCTAssertEqual(asks, 1, "the read request moved")
    }

    /// F9: the recording caption's value names a test path; a Release build has none.
    func testTheRecordingSourceValueIsDebugOnly() throws {
        let composer = try source("Walnut/Views/Chat/ComposerView.swift")
        let value = try XCTUnwrap(composer.range(of: #".accessibilityValue(deliverySource ?? "mic-button")"#))
        let before = composer[..<value.lowerBound]
        let opened = try XCTUnwrap(before.range(of: "#if DEBUG", options: .backwards))
        XCTAssertNil(before[opened.upperBound...].range(of: "#endif"), "the value is outside #if DEBUG")
        XCTAssertNotNil(composer[value.upperBound...].prefix(200).range(of: "#endif"))
    }

    /// F10: VoiceOver reads the status, not "circle.lefthalf.filled".
    @MainActor
    func testTheStatusToggleSpeaksTheStatus() throws {
        XCTAssertEqual(StatusCircle.spoken(.todo), "To do")
        XCTAssertEqual(StatusCircle.spoken(.inProgress), "In progress")
        XCTAssertEqual(StatusCircle.spoken(.done), "Done")
        XCTAssertEqual(StatusCircle.toggleAccessibility(.inProgress).label, "Status")
        XCTAssertEqual(StatusCircle.toggleAccessibility(.inProgress).value, "In progress")
        XCTAssertEqual(StatusCircle.toggleAccessibility(.done).hint, "Marks the task as to do.")
        for file in ["Walnut/Views/Tasks/TaskDetailSheet.swift", "Walnut/Views/Sessions/SessionTaskRow.swift"] {
            let text = try source(file)
            XCTAssertTrue(text.contains(".accessibilityLabel(StatusCircle.toggleAccessibility("), file)
            XCTAssertTrue(text.contains(".accessibilityValue(StatusCircle.toggleAccessibility("), file)
        }
    }

    /// F11: the Notes folder icon read as "Move".
    @MainActor
    func testTheNotesFolderRowSaysFolder() throws {
        XCTAssertTrue(try source("Walnut/Views/Notes/NotesRows.swift").contains(#".accessibilityLabel("Folder")"#))
        XCTAssertEqual(FolderRow.countLabel(1), "1 note")
        XCTAssertEqual(FolderRow.countLabel(4), "4 notes")
    }

    /// F12: the keyboard is put away before the camera covers the screen, so a
    /// cancel does not bring it back over the tab bar.
    func testTheCameraPutsTheKeyboardAwayFirst() throws {
        let composer = try source("Walnut/Views/Chat/ComposerView.swift")
        let open = try XCTUnwrap(composer.range(of: "private func openCamera() {"))
        let body = composer[open.upperBound...].prefix(900)
        let blur = try XCTUnwrap(body.range(of: "focused = false"))
        let show = try XCTUnwrap(body.range(of: "showCamera = true"))
        XCTAssertLessThan(blur.lowerBound, show.lowerBound)
        XCTAssertTrue(body.contains("longDraftFocused = false"))
    }

    /// F14: while iOS's own location question is up, the note does not send the
    /// user to Settings.
    @MainActor
    func testThePlacesNoteWaitsForIOSsQuestion() {
        // `iosCanAsk` as the screen computes it (PlacesStore), from the access and
        // whether Walnut already put the Always question.
        func note(_ access: PlacesPhoneState.Access, asking: Bool, askedAlways: Bool) -> String {
            PlacesView.accessNote(access: access, asking: asking,
                                  iosCanAsk: PlacesAccessDecision.iosCanAsk(access: access, askedAlways: askedAlways))
        }
        XCTAssertEqual(note(.notDetermined, asking: true, askedAlways: false), PlacesView.answerNote)
        XCTAssertEqual(note(.whenInUse, asking: true, askedAlways: false), PlacesView.answerNote)
        XCTAssertFalse(PlacesView.answerNote.contains("Settings"))
        XCTAssertTrue(note(.whenInUse, asking: false, askedAlways: true).contains("In Settings"))
        XCTAssertTrue(note(.whenInUse, asking: false, askedAlways: false).contains("Tap Allow Always"))
        XCTAssertTrue(note(.denied, asking: false, askedAlways: false).contains("In Settings"))
        // No answer yet: iOS can always ask, so the note never sends this user to Settings.
        for askedAlways in [false, true] {
            XCTAssertTrue(note(.notDetermined, asking: false, askedAlways: askedAlways).contains("Tap Allow Always"))
        }
        XCTAssertTrue(note(.restricted, asking: true, askedAlways: false).contains("restricted"))
    }

    /// F5: at the accessibility sizes the pinned bar gives the page room: no
    /// third folder notice over the composer, the mode and model pills beside
    /// the folder pill instead of stacked in the composer, the quick folders
    /// scroll with the page, and the empty state sits near the top. The demo
    /// still opens with no folder picked.
    func testTheDraftKeepsItsPageAtTheAccessibilitySizes() throws {
        let draft = try source("Walnut/Views/Sessions/NewSessionChatView.swift")
        XCTAssertTrue(draft.contains("disabledNotice: canLaunch || dynamicTypeSize.isAccessibilitySize ? nil : Self.folderNotice"))
        XCTAssertTrue(draft.contains("controlsAccessory: dynamicTypeSize.isAccessibilitySize ? nil : AnyView(launchPills)"))
        let row = try XCTUnwrap(draft.range(of: "private var pillRow: some View {"))
        let rowBody = draft[row.upperBound...].prefix(700)
        XCTAssertTrue(rowBody.contains("if dynamicTypeSize.isAccessibilitySize {\n                    launchPills"))
        XCTAssertTrue(draft.contains("return ComposerBar.pillLayout(stacked: false) {"))
        XCTAssertTrue(draft.contains("if !quickDirs.isEmpty, !movesQuickFoldersIntoPage {"))
        XCTAssertTrue(draft.contains("!quickDirs.isEmpty && dynamicTypeSize.isAccessibilitySize"))
        let page = try XCTUnwrap(draft.range(of: "private var introOrStatus: some View {"))
        let bar = try XCTUnwrap(draft.range(of: "private var launchBar: some View {"))
        let body = draft[page.upperBound..<bar.lowerBound]
        let linked = try XCTUnwrap(body.range(of: #""newSessionChat.linkedTask""#))
        let chips = try XCTUnwrap(body.range(of: "if movesQuickFoldersIntoPage {"))
        let empty = try XCTUnwrap(body.range(of: "if showsEmptyState {"))
        XCTAssertLessThan(linked.lowerBound, chips.lowerBound)
        XCTAssertLessThan(chips.lowerBound, empty.lowerBound)
        XCTAssertTrue(draft.contains(".padding(.top, dynamicTypeSize.isAccessibilitySize ? 8 : 120)"))
        XCTAssertFalse(NewSessionChatView.draftStart(inDemo: true).preselectFolder)
    }
    /// The microphone string names the same destination as Health and Places,
    /// and the speech service the server may use (PRIVACY.md, "Your server").
    func testTheMicrophoneStringNamesTheServerAndItsSpeechService() throws {
        for file in ["project.yml", "Walnut/Support/Info.plist"] {
            let text = try source(file)
            XCTAssertTrue(text.contains("Your recording goes only to your own Walnut server, on your Mac or on a cloud machine you run, which turns it into text itself or with a speech service you set up on it."), file)
            XCTAssertFalse(text.contains("Your speech is turned into text by your own Walnut server."), file)
        }
    }
}
