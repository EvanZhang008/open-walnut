/**
 * A thing the phone app takes off the screen by itself on a clock (a notice, an Undo offer, a run's
 * outcome, a tap-again window) waits through `NoticeTiming` (ios-native/Walnut/Core/NoticeTiming.swift),
 * which holds it at least 8 s in a UI-test launch of a debug build.
 *
 * On CI's slower simulator a tap returns only once the app is idle and each query takes 1 to 3 s, so
 * a UI test that has to find the thing and then tap or read it lost the race to a timer of 2.5 to
 * 5 s (2026-11-16 SessionChanges "Copy said nothing"; 2026-11-24 Routines "Ran just now", gone 4 s
 * after it showed, and the review's Undo, gone 5 s after a swipe, red in 8 of 8 main runs).
 *
 * The members are read from the source (tests/web/ios-timed-hide-scan.ts): under ios-native/Walnut,
 * every wait (`Task.sleep`, `asyncAfter`, a `DispatchWorkItem` it runs, a `Timer`) of a second or
 * more whose work then takes something away (`x = nil`, `x = false`, `f(false)`, `dismiss()`,
 * `clear...()`, `hide...()`, `remove...()`), every take-away in that work, and every date window (a
 * stored "until" deadline, or a check of how long ago something was stamped). Each one either names
 * `NoticeTiming` or is in KNOWN with why it is not a passing thing a test must catch; each KNOWN entry
 * covers one member (or `count`), so a new one with the same text in the same file is judged again.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { code, swiftFiles, timedHides, throughNoticeTiming, uncovered, type KnownHide } from './ios-timed-hide-scan'

const APP = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

// Reasons shared by many date windows and waits.
const FRESH = 'how fresh a read or a cache is: decides whether to ask again; nothing shown goes'
const AGAIN = 'a debounce or a repeat guard: decides whether to act again; nothing shown goes'
const BUDGET = 'a background wait, retry or work budget; nothing shown goes'
const QUIET = 'how long an ask stays quiet after an answer: keeps a prompt from showing, takes nothing shown away'
const TYPING = 'a settle window after typing, a scroll or a layout change, not shown'
const LONG = 'a span of minutes or more, far past any UI test'

const k = (file: string, takes: string, why: string, count?: number): KnownHide => ({ file, takes, why, count })

/** Timed take-aways that are not a passing thing a UI test must catch, by file and what they clear. */
const KNOWN: KnownHide[] = [
  // Waits whose work takes something away.
  k('Stores/ChatStore.swift', 'self.fileRetryTasks[bubbleID] = nil', 'a retry backoff forgets its own task'),
  k('Stores/ChatStore.swift', 'failed = false', 'a retry backoff sends the failed file again: the failed mark goes because the send starts'),
  k('Stores/ChatStore.swift', 'retryNotice = nil', 'a retry backoff sends the failed file again: its waiting notice goes because the send starts'),
  k('Stores/ChatStore.swift', 'uploadFailedID = nil', 'a retry backoff sends the failed file again'),
  k('Stores/SessionConversationStore.swift', 'self.retryTasks[bubbleID] = nil', 'a retry backoff forgets its own task', 2),
  k('Stores/SessionConversationStore.swift', 'self?.stopRequestedAt = nil', 'the Stop request times out; nothing on screen goes'),
  k('Stores/FocusMusicPlayer.swift', 'self.focusWatch = nil', 'the Focus watch ends with the block; nothing is shown', 2),
  k('Stores/FocusSpacesStore.swift', 'self.expireIfDue', 'a Focus block ends at its own clock time, which the person set'),
  k('Stores/TasksStoreStatusPrediction.swift', 'self?.expirePrediction', 'a predicted status gives way to the server\'s; nothing to read or tap', 2),
  k('Views/Tasks/GlobalSearchModel.swift', 'self.searching = false', 'a search debounce'),
  k('Views/Tasks/GlobalSearchModel.swift', 'self.response = nil', 'a search debounce: a new query replaces the answer'),
  k('Views/Tasks/GlobalSearchModel.swift', 'self.unavailableNotice = nil', 'a search debounce: an answer replaces the notice'),
  k('Stores/SessionQueueModel.swift', 'self.fadeTask = nil', 'wakes the badge to read its state again; the Delivered span is judged in updateSendStates and no UI test reads it'),
  k('Views/Chat/ChatView.swift', 'restoreWaitsForOpen = false', 'a launch restore stops waiting for a deep link; nothing on screen goes'),
  k('Views/Chat/ComposerView.swift', 'seatSettling = false', 'a stray-tap guard after the seat moves, not shown'),
  k('Views/Inbox/LetterThreadView.swift', 'movingId = nil', 'ends a move animation'),
  k('Views/Sessions/SessionConversationView.swift', 'coveredUntilPage = false', 'the longest a cover hides an unpainted page; ending sooner is the point'),
  k('Views/Sessions/SessionQueueViews.swift', 'dismiss', 'the edit sheet closes itself after its row went out; held longer it would sit over the page the test goes on to'),
  k('Talk/TalkSetupView.swift', 'dismiss', 'the Action Button sheet closes after a Resend; held longer it would sit over the page the test goes on to'),
  k('Talk/TalkPanel.swift', 'self.close', 'the Talk panel closes after a take (callers pass 0.5 to 2 s); its UI tests read it while the take runs, and they need the audio Mac, so a longer hold is not proven safe', 2),
  k('Talk/TalkSession.swift', 'self?.retryLater = nil', 'a retry wait forgets its own task'),
  k('Stores/ChatStore.swift', 'self?.laneFollow = nil', 'a lane follow forgets its own task; nothing shown goes'),
  k('Stores/InboxItemStore.swift', 'self.queryJobs[key] = nil', 'a background query forgets its own job'),
  k('Stores/SessionConversationStore.swift', 'restoredWaiting.removeAll', 'the restored sends\' check gives up after its tries; nothing shown goes'),
  k('Stores/SessionConversationStore.swift', 'self?.restoredGoing.remove', 'a put-back send\'s first try ended: what was sent after it may go; nothing shown goes'),
  k('Stores/SessionConversationStore.swift', 'self.gateExpiryTask = nil', 'the stream gate\'s expiry forgets its own task'),
  k('Stores/SessionConversationStore.swift', 'self.gate.expire', 'the stream gate lets held events through at its deadline; it adds, never takes a shown thing away'),
  k('Stores/SessionConversationStore.swift', 'self.replayHoldTask = nil', 'the replay hold forgets its own task'),
  k('Views/Inbox/InboxItemConfirmation.swift', 'store.expirePlan', 'a plan expires at the time the server gave it, minutes away'),
  k('Core/VoiceLiveUploader.swift', 'advanced = false', 'the live upload\'s own step flag, not shown'),
  k('Core/SilentVoiceTake.swift', 'failOnce = false', 'a debug dictation fixture'),
  k('Views/Org/OrgThreadsView.swift', 'testMark = nil', 'the UI tests\' own reveal mark, already 8 s (testMarkSeconds)'),
  k('Views/Org/OrgThreadsView.swift', 'highlight = nil', 'a tint UI tests read through testMark; holding it longer would show under the next push\'s held sheet (expectHeld)'),
  k('Views/Tasks/TasksView.swift', 'highlightedTaskId = nil', 'a row tint, nothing to read or tap, no UI test reads it'),
  k('Views/Sessions/FileSourceLinesView.swift', 'flash = false', 'a line tint after a jump, nothing to read or tap'),
  k('Timeline/TimelineTextCells.swift', 'showCopied(false)', 'its Copied label is read by polling with no tap between, and CodeBlockUITests checks it comes back within 5 s'),
  k('Timeline/TimelineHarnessView.swift', 'self?.streaming = false', 'the debug timeline harness\'s scripted stream'),
  k('Timeline/TimelineHarnessView.swift', 'self.streaming = false', 'the debug timeline harness\'s scripted stream'),
  k('Timeline/TimelineHarnessView.swift', 'self.activity = nil', 'the debug timeline harness\'s scripted stream'),

  // Stored "until" deadlines.
  k('Stores/SessionQueueModel.swift', 'hiddenUntil', 'keeps a row that is going out hidden so it does not flash back; it hides, never takes a shown thing away'),
  k('Stores/SessionStreamGate.swift', 'holdDeadline', 'how long a stream restart is held back; nothing shown goes'),
  k('Views/Chat/ChatDrawer.swift', 'orgSettleUntil', 'the drawer\'s rows keep their order while it opens, not shown'),
  k('Views/Inbox/LetterReplyField.swift', 'echoGuardUntil', 'ignores the text view\'s own echo after a send, not shown'),
  k('Views/Inbox/LetterFollowsNewestStatus.swift', 'sendScrollEnds', TYPING),
  k('Views/ScrollBottomTracking.swift', 'armHoldCeiling', TYPING),
  k('Health/HealthAccessPrompt.swift', 'quietUntil', QUIET, 3),
  k('Places/PlacesAccessPrompt.swift', 'quietUntil', QUIET, 3),
  k('Health/HealthBackground.swift', 'earliestBeginDate', 'the earliest a background refresh may run; nothing shown'),

  // How long ago something was stamped.
  k('Stores/SessionQueueModel.swift', 'since at', 'the Delivered badge span; no UI test reads it (see fadeTask)'),
  k('Stores/SessionQueueModel.swift', 'since $0.since', 'how long a queue row is watched fast; nothing shown goes'),
  k('Views/Org/OrgThreadsView.swift', 'since sent', 'the "Follow up sent" line shows for 10 minutes, far past any UI test'),
  k('Views/Org/OrgThreadModel.swift', 'since at', 'a closed thread is Archived a day after it closed'),
  k('Views/Org/OrgThreadsStore.swift', 'since settledAt', 'the store keeps writing out a moment after it settled, not shown'),
  k('Views/Org/OrgAvatar.swift', 'since at', FRESH),
  k('Stores/ServerClientSettings.swift', 'since lastRead', FRESH),
  k('Stores/TagDisplayStore.swift', 'since lastRead', FRESH),
  k('Stores/TasksStoreRefresh.swift', 'since last', FRESH, 2),
  k('Stores/ComposerSuggestController.swift', 'since cached.at', FRESH),
  k('Stores/InboxStore.swift', 'since lastRefreshAt', FRESH),
  k('Stores/RouteCoordinator.swift', 'since $0.value', 'a rejected route is skipped for a while; nothing shown'),
  k('Stores/RouteCoordinator.swift', 'since last.at', AGAIN),
  k('Stores/LetterReplyStore.swift', 'since $0.value', 'drafts older than their keep time are forgotten; ' + LONG),
  k('Stores/HeldSessionSends.swift', 'since lastFollow', AGAIN),
  k('Stores/PendingFileSends.swift', 'since $0.savedAt', 'kept file sends older than their keep time are forgotten; ' + LONG),
  k('Stores/SessionConversationStore.swift', 'since $0.value.stashedAt', 'a stashed message older than its keep time is forgotten; nothing shown'),
  k('Stores/SessionConversationStore.swift', 'since entry.stashedAt', 'a stashed message older than its keep time is forgotten; nothing shown'),
  k('Stores/SessionConversationStore.swift', 'since heldSavedAt[bubbleID]??.distantPast', 'how often an upload\'s progress is saved; nothing shown goes'),
  k('Stores/ChatStore.swift', 'since created', 'a local echo the server never confirmed gives way to the server\'s list'),
  k('Stores/ChatStore.swift', 'since self.lastSSEEventAt', 'a silent event stream is reconnected; nothing shown goes'),
  k('Stores/TasksStore.swift', 'since $0.createdAt', 'a just-created task the server never listed gives way to the server\'s list'),
  k('Stores/TasksStoreStatusPrediction.swift', 'since p.madeAt', 'a predicted status gives way to the server\'s'),
  k('Stores/VoiceModeController.swift', 'since since.at', 'how long voice mode waits for the final words before it speaks; nothing shown goes'),
  k('Stores/PasswordsStore.swift', 'since at', 'Passwords lock after the app sat in the background; a lock, not a passing thing'),
  k('Core/OrgNodeLink.swift', 'since since', BUDGET),
  k('Core/RouteSelector.swift', 'since last', AGAIN),
  k('Core/VoiceLiveWords.swift', 'since since', 'how often live words are sent; nothing shown goes'),
  k('Core/VoiceRecordingStore.swift', 'since last', AGAIN),
  k('Core/WorkCardController.swift', 'since startedAt', 'the system\'s own Live Activity time limit'),
  k('App/DebugThreadPushLink.swift', 'since last.at', AGAIN),
  k('Views/Tasks/WorkCardSheet.swift', 'since last.at', AGAIN),
  k('Views/Tasks/TeamStatusModel.swift', 'since $0', 'how long a teammate has been quiet, read from the server\'s times'),
  k('Views/Chat/ComposerPrimaryAction.swift', 'since lastTap', AGAIN),
  k('Views/Chat/PillMenuButton.swift', 'since at', 'where focus returns after a menu, not shown'),
  k('Views/Chat/ComposerModelRefreshPolicy.swift', 'since started', AGAIN),
  k('Views/Chat/ComposerModelRefreshPolicy.swift', 'since ended', AGAIN, 2),
  k('Views/Chat/ComposerModelRefreshPolicy.swift', 'since last', FRESH),
  k('Views/Inbox/LetterReaderView.swift', 'since noteChangedAt', TYPING),
  k('Views/Sessions/PermissionRequestCard.swift', 'since $0', TYPING),
  k('Views/Sessions/PermissionRequestCard.swift', 'since picturesAddedAt', TYPING),
  k('Views/Sessions/PermissionRequestCard.swift', 'since typedAt', TYPING),
  k('Views/Sessions/PermissionRequestCard.swift', 'since grewAt', TYPING),
  k('Health/HealthAccessPrompt.swift', 'since last', QUIET),
  k('Health/HealthSyncEngine.swift', 'since $0', FRESH),
  k('Health/HealthSyncEngine.swift', 'since env.now()', BUDGET, 2),
  k('Health/HealthSyncState.swift', 'since lastWrite', 'how often the sync state is saved; nothing shown goes'),
  k('Places/PlacesAccessPrompt.swift', 'since last', QUIET),
  k('Places/PlacesAlwaysTiming.swift', 'since started', BUDGET),
  k('Places/PlacesAlwaysTiming.swift', 'since since', BUDGET),
  k('Places/PlacesQueue.swift', 'since $0.lastMoment', 'sent visits older than their keep time are forgotten; ' + LONG),
  k('Places/PlacesRecorder.swift', 'since started', BUDGET, 2),
  k('Places/PlacesSyncEngine.swift', 'since $0', FRESH),
  k('Places/PlacesSyncEngine.swift', 'since started', BUDGET),
  k('Demo/DemoServerWorkCard.swift', 'since idle', 'the demo server\'s scripted work card'),
]

describe('iOS: a thing taken off the screen on a clock waits through NoticeTiming', () => {
  const hides = swiftFiles(APP).flatMap((f) => timedHides(path.relative(APP, f), code(fs.readFileSync(f, 'utf8'))))
  const notThrough = hides.filter((h) => !throughNoticeTiming(h))

  it('finds the members it guards', () => {
    const where = hides.map((h) => `${h.file} ${h.takes}`)
    expect(where).toContain('Views/Settings/RoutinesView.swift runNotes[id] = nil')
    expect(where).toContain('Timeline/TimelineTextCells.swift showCopied(false)')
    expect(where).toContain('Views/Sessions/PermissionRequestCard.swift since armedAt')
    expect(where).toContain('Stores/SessionQueueModel.swift hiddenUntil')
    expect(where).toContain('Views/Chat/ComposerView.swift onDismiss')
  })

  it('every timed take-away names NoticeTiming or says why it is not a passing thing', () => {
    const offenders = uncovered(notThrough, KNOWN).map((h) => `${h.file}:${h.line} ${h.wait} -> ${h.takes}`)
    expect(
      offenders,
      'wait with `NoticeTiming.after(normal) { ... }`, or `NoticeTiming.seconds(normal)` in the sleep or the window',
    ).toEqual([])
  })

  it('KNOWN lists only take-aways that are still there, as many as it says', () => {
    const stale = KNOWN.filter((entry) => {
      const n = notThrough.filter((h) => h.file === entry.file && h.takes === entry.takes).length
      return n < (entry.count ?? 1)
    })
    expect(stale.map((entry) => `${entry.file} ${entry.takes} x${entry.count ?? 1}`)).toEqual([])
    const keys = KNOWN.map((entry) => `${entry.file} ${entry.takes}`)
    expect(keys.filter((key, i) => keys.indexOf(key) !== i), 'one entry per take-away, with count').toEqual([])
  })

  it('the members a UI test catches wait through NoticeTiming', () => {
    const src = (f: string) => code(fs.readFileSync(path.join(APP, f), 'utf8'))
    for (const f of [
      'Views/Sessions/Changes/DiffReviewViews.swift',
      'Views/Sessions/Changes/SessionFileDiffView.swift',
      'Views/Sessions/PermissionRequestCard.swift',
      'Stores/SessionQueueModel.swift',
      'Views/Chat/Camera/CameraCaptureModel.swift',
      'Markdown/MarkdownView.swift',
    ]) expect(src(f), f).toMatch(/NoticeTiming\.after\(/)
  })

  it('catches each kind of wait and take-away, and leaves short and unrelated waits', () => {
    const all = (s: string) => timedHides('x', code(s))
    const one = (s: string) => all(s).length
    expect(one('Task { try? await Task.sleep(for: .seconds(5)); if a == b { removed = nil } }')).toBe(1)
    expect(one('Task { try? await Task.sleep(nanoseconds: 2_500_000_000)\n withAnimation { id = nil } }')).toBe(1)
    expect(one('DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { copied = false }')).toBe(1)
    expect(one('let reset = DispatchWorkItem { [weak self] in self?.show(false) }\nDispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: reset)')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .seconds(Self.window)); self.offer = nil }')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .milliseconds(250)); frozen = false }')).toBe(0)
    // A named length is read where the file declares it: a 100 ms poll is no timed hide.
    expect(one('static let tick: Duration = .milliseconds(100)\nTask { try? await Task.sleep(for: Self.tick); listening = false }')).toBe(0)
    expect(one('static let window: Duration = .seconds(5)\nTask { try? await Task.sleep(for: Self.window); offer = nil }')).toBe(1)
    expect(one('static let hold: TimeInterval = 0.2\nDispatchQueue.main.asyncAfter(deadline: .now() + Self.hold) { shown = false }')).toBe(0)
    // Two lengths of one name in a file: which one a wait reads is not known, so it counts, above
    // or below the use (2026-11-25 review: B's 4 s was read as A's 0.2 s).
    expect(one('struct A { static let hold = 0.2 }\nstruct B { static let hold = 4\n func f() { DispatchQueue.main.asyncAfter(deadline: .now() + Self.hold) { shown = false } } }')).toBe(1)
    expect(one('struct A { static let hold = 0.2 }\nstruct B { func f() { DispatchQueue.main.asyncAfter(deadline: .now() + Self.hold) { shown = false } }\n static let hold = 4.0 }')).toBe(1)
    // A declaration of the name that is no length (a view's object) is not read as one.
    expect(one('@State private var settle = Settle()\nstatic let settle: Duration = .milliseconds(150)\nTask { try? await Task.sleep(for: Self.settle); self.pending = nil }')).toBe(0)
    // A sleep in a `do`, a loop or an `if`: the take-away after the block is its work.
    expect(one('.task { do { try await Task.sleep(for: .seconds(3)) } catch { return }\n store.expirePlan(key) }')).toBe(1)
    expect(one('Task { if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }\n self.close() }')).toBe(1)
    expect(one('Task { for _ in 0..<3 { try? await Task.sleep(for: .seconds(2)) }\n banner = nil }')).toBe(1)
    // Up to the next long wait; a short step between does not end it.
    expect(all('Task { try? await Task.sleep(for: .seconds(2)); try? await Task.sleep(for: .seconds(NoticeTiming.seconds(4))); note = nil }').map((h) => h.wait)).toEqual(['Task.sleep(for: .seconds(NoticeTiming.seconds(4)))'])
    expect(one('Task { try? await Task.sleep(for: .seconds(2)); for c in cs { try? await Task.sleep(for: .milliseconds(80)) }\n self.activity = nil }')).toBe(1)
    // An injected clock's sleep.
    expect(one('Task { try? await clock.sleep(seconds: Self.holdSpan); self.hold = nil }')).toBe(1)
    expect(one('Task { do { try await sleep(wake.delay) } catch { return }\n toast = nil }')).toBe(1)
    expect(one('Task { try? await clock.sleep(seconds: 0.2); self.hold = nil }')).toBe(0)
    expect(one('Task { try? await Task.sleep(for: .seconds(5)); await refresh() }')).toBe(0)
    expect(one('if a == nil { Task { try? await Task.sleep(for: .seconds(3)) } }\nx = nil')).toBe(0)
    // A call that takes something away after the wait (2026-11-25 review: dismiss() and clear() were missed).
    expect(one('Task { try? await Task.sleep(for: .seconds(1.2)); dismiss() }')).toBe(1)
    expect(one('.task { try? await Task.sleep(for: .seconds(6)); talk.clearResentNotice() }')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .seconds(3)); self?.hideBanner() }')).toBe(1)
    expect(one('Task { try? await Task.sleep(for: .seconds(3)); rows.removeAll { $0.gone } }')).toBe(1)
    // Every take-away in the work, not only the first: a known first one never hides the next.
    expect(all('Task { try? await Task.sleep(for: .seconds(4)); task = nil; notice = nil }').map((h) => h.takes)).toEqual(['task = nil', 'notice = nil'])
    // A Timer, scheduled or added to a run loop, and its block.
    expect(one('Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in self.toast = nil }')).toBe(1)
    expect(one('let t = Timer(timeInterval: 2.5, repeats: false) { [weak self] _ in self?.dismiss() }')).toBe(1)
    expect(one('Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { _ in self.toast = nil }')).toBe(0)
    // Date windows: a stored deadline and an age check, a local budget and a short window left out.
    expect(all('func f() { hiddenUntil[id] = Date().addingTimeInterval(Self.span) }').map((h) => h.takes)).toEqual(['hiddenUntil'])
    expect(all('if isOpen { quietUntil = .now + 30 }').map((h) => h.takes)).toEqual(['quietUntil'])
    expect(all('if Date().timeIntervalSince(armedAt) < 5 { confirm() }').map((h) => h.takes)).toEqual(['since armedAt'])
    expect(all('if armedAt.timeIntervalSinceNow > -5 { confirm() }').map((h) => h.takes)).toEqual(['since armedAt'])
    expect(all('if 5 > Date().timeIntervalSince(armedAt) { confirm() }').map((h) => h.takes)).toEqual(['since armedAt'])
    expect(one('let deadline = Date().addingTimeInterval(30)')).toBe(0)
    expect(one('let cutoff = now.addingTimeInterval(-86_400)')).toBe(0)
    expect(one('if now.timeIntervalSince(typedAt) < 0.5 { return true }')).toBe(0)
    expect(all('if Date().timeIntervalSince(armedAt) < NoticeTiming.seconds(5) { confirm() }').every(throughNoticeTiming)).toBe(true)
  })

  it('a KNOWN entry covers as many take-aways as it says, so a second of the same text is judged again', () => {
    const h = (line: number) => ({ file: 'f.swift', line, kind: 'wait' as const, wait: 'w', takes: 'x = nil' })
    expect(uncovered([h(1)], [k('f.swift', 'x = nil', 'why')])).toEqual([])
    expect(uncovered([h(1), h(9)], [k('f.swift', 'x = nil', 'why')]).map((x) => x.line)).toEqual([9])
    expect(uncovered([h(1), h(9)], [k('f.swift', 'x = nil', 'why', 2)])).toEqual([])
    expect(uncovered([h(1)], [k('g.swift', 'x = nil', 'why')]).map((x) => x.line)).toEqual([1])
  })
})
