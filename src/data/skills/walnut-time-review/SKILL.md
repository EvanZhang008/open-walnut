---
name: walnut-time-review
description: >-
  Answer where the user's time went, from what Walnut measured: minutes in
  Walnut tasks, Mac apps, sleep and workouts (Apple Health), places (iPhone
  visits) and the calendar. Use when the user asks where their time went (a
  day, a week), why something did not get done, whether they kept today's plan,
  how scattered their days are, how much went to meetings, ops or evenings, or
  asks for a time audit or time review. Owns time_report, time_timeline and the
  recipe for a time review.
---

# Time review

Walnut measures where the user's attention went. This skill turns that into an
answer a person can act on: what the time went to, in work hours and over the
whole day, what got in the way, and what needs a decision. Read the data with
the ops below; never parse the JSONL files under the data directory by hand.

## 1. Which op answers which question

- **How much time went to what, over a range** (tasks, projects, apps, sites,
  hours of the day, days; up to 31 days, the last 90 days only):
  `time_report`.

  ```
  walnut tools call time_report '{"from":"2026-10-05","to":"2026-10-09","group_by":"day,task,project,app"}'
  walnut tools call time_report '{"last_days":7}'
  ```

  `group_by` takes any of `task, project, hour, kind, app, host, view, file,
  item`, as a comma list or an array (default `task,project`; `day` rows always
  come back). `view` is the part of a session panel that had the input (chat,
  files, changed, board, terminal…; `unknown` for days before views were
  recorded); `file` is the file open in a session's file viewer; `item` is a
  plugin's own item inside Walnut (a channel, a thread) with `replyMin` for time
  in its reply box. `kinds` defaults to the user's own time
  (`session,triage,chat,app`; `app` = a plugin's view inside Walnut). `top`
  (default 15) caps each group; the rest is summed in `otherMin`.
- **What did one day look like, from every source at once** (Walnut, Mac apps,
  sleep, workouts, calendar, places, plugins), and **was the plan kept**:
  `time_timeline` (up to 7 days; this Mac only, because it carries places and
  health).

  ```
  walnut tools call time_timeline '{"date":"2026-10-08"}'
  ```

- **A day in words** (tasks touched, sessions, health, meetings): `day_review`.
- **Today and this week at a glance**: `time_summary`.
- **More about the tasks in a report** (summary, progress, dates): `task_get_bulk`
  with the `taskId`s from the report. Titles, projects, phase, creation date and
  source already come with every report row.
- **Where the user was**: `places_visits`. **Name a place once** ("this is
  home", "that is the office"): `places_label_set` with a visit id or a word from
  the place's name or address. Later visits near it read with that name.
- **Sleep and workouts in detail**: `health_sleep`, `health_daily`.
- **What was on the calendar**: the calendar plugin's query op, read only
  (`time_timeline` already reads it).
- **The user's work hours**: `time_work_hours_set` (`{"start":"08:30","end":"17:30","days":["mon","tue","wed","thu","fri"]}`,
  or `{"reset":true}`).
- **Whether the user attended a meeting the timeline could not decide**:
  `time_meeting_attendance_set` with the meeting's `eventId` and the user's
  answer (`{"event_id":"…","attended":false}`, `null` clears it).
- **Leave a meeting out of plan checks** when the user asks ("ignore the team
  lunch"): `time_meetings_ignore_set` (`{"patterns":["lunch"]}`; `[]` clears).

## 2. Two views, always: work hours and the whole day

Every answer shows both. Work hours are the user's setting (default 09:00 to
18:00, Monday to Friday); every report says which hours it used in
`workHours.label` and whether they are the user's setting (`source: "config"`)
or the default.

- `time_report`: `totals.workHours` and `totals.wholeDay` (plus `offHours`);
  `totals.workHours.shareOfDay` is how much of the day's attention fell inside
  work hours. Every row has `min` (whole day), `workMin`, `offMin`, `shareOfDay`
  and `workShare` (its share of work-hours attention).
- `time_timeline`: `summary.workHours` and `summary.wholeDay` per day.

When the question is about work, lead with work hours, then the whole day.
When it is about life, rest or evenings, lead with the whole day. If the user
names other hours for one question, pass `work_start`, `work_end`, `work_days`
to that call; if they say these are their hours, save them with
`time_work_hours_set` and say so.

## 3. What each source can know, and what it cannot

**Walnut attention** (`walnutMin`, the `walnut` source)
- Knows: time with a Walnut session, triage row or chat, per task, to the
  minute, on the Mac and in the phone app (`phoneMin`).
- How: a lease. A real interaction (click, key, scroll, selection) gives that
  task the next 60 seconds; switching to another task, another session view,
  another file or another plugin item banks the old one at the switch. The lease
  ends when the window loses focus to another app, and the report cuts any
  second another Mac app was frontmost (`overlapMin`), so no second counts twice.
- `readingMin` (inferred): Walnut frontmost with no click or key (moving the
  pointer, reading), credited to the context used last, at most 15 minutes
  after it and only while Walnut stayed in front. It is counted in attention,
  kept apart from `walnutMin`; say "about" for it.
- `sent`: messages the user sent (count and length, never the text), per day
  and per task.
- Cannot know: thinking away from the screen, or reading with the Mac idle for
  more than two minutes. File minutes are input with that file open, not proof
  it was read. Session minutes are a floor of attention.

**Agent time** (`agentMin`)
- Knows: how long agents ran for a task on their own.
- It costs the user no attention. Never add it to the user's time, never
  call it "time spent"; report it apart, as work done for them.

**Mac apps** (`outside`, the `mac-apps` source)
- Knows: the frontmost Mac app every ~5 seconds, and the site for a scriptable
  browser (host only, never the full address).
- Leaves out: idle over 120 seconds and the lock screen. A call the user only
  listened to is not screen time; the calls source below sees it.
- Walnut's own window is `walnutForegroundMin`, a cross-check, never added
  (the lease already counts it).
- Cannot know: what was done inside the app, or anything on the phone outside
  Walnut.

**Sleep** (Apple Health, the `sleep` source)
- Knows: nights with their start and wake times; `in_bed_only` when the watch
  did not record actual sleep.
- Use it to explain a late start or a short evening, and to note energy. Never
  quote raw health values in a report; say "a short night (about 5 h)" when it
  matters.

**Workouts** (Apple Health, the `workouts` source)
- Knows: workouts with their type and length.
- A workout that runs into a night of sleep is a watch left running: the timeline
  shows only its first 2 hours (ending at bedtime when that comes first) and
  flags it with the recorded length. Report the shown part and say the watch
  was left running; never add the recorded length to exercise.

**Places** (iPhone visits, the `places` lane)
- Knows: where the user stayed a while (home, office, gym, any named place),
  from the day Places was turned on. Coverage is in the timeline's `sources`
  note; say when the window starts before it.
- Travel between two places is `inferred` from the gap, not measured; a quick
  stop can be missing.

**Calls** (`callMin`, the `calls` source, this Mac only)
- Knows: when a call app (Zoom, Teams, Webex, FaceTime, or one the user added
  in `time.calls.apps`) held a call on this Mac, to the second, from macOS power
  assertions; also a browser or chat app holding a WebRTC call (labelled
  "… WebRTC call": it can also be a real-time web app that is not a call).
  Recorded while outside activity is on; the first run recovers the week macOS
  still keeps.
- A call in progress is not attention to it. `callMin` overlaps screen time:
  never add it to attention. `adHocCallMin` is call time no meeting explains.

**Calendar** (the `calendar` source, read only)
- Knows: what was planned (meetings, focus blocks), not what happened. Every
  calendar segment is `planned`. An event with a call link, a room booking or
  other people invited is a meeting.
- Room bookings that repeat a meeting count once.

**Plugin sources**
- A plugin may add its own (a car, a fitness app). Its id is
  `<plugin>:<source>`; it never outranks what the Mac measured.

**Never visible**: paper, in-person talks, phone calls, the phone's other apps,
anything away from the Mac. When a gap matters, ask; do not invent.

## 3b. Meetings: attended or not

Each meeting in `time_timeline` `plan` carries `attendance` and why
(`attendanceBasis`), decided from the calls on this Mac:

- `attended` (basis `call`): a call ran during it. `meetingMin` is the call's
  minutes inside the meeting minus `otherWorkMin`, the seconds the user was
  doing something else on screen (Walnut input, another app in front). Report
  `meetingMin`, not the calendar length.
- `not_attended`: a recurring meeting never on a call in the last four weeks
  (basis `recurring_never_on_call`), or no call while the screen showed other
  work for at least half of it (basis `other_work`: the time belongs to that
  work).
- `needs_confirmation`: never count it and never guess. Ask the user, listing
  `summary.needsConfirmation` (title, time, basis), then record each answer
  with `time_meeting_attendance_set`. Their answer then wins (basis `user`).
  Two bases:
  - `nothing_recorded`: no call and nothing on the screen (the Mac idle, asleep
    or away). Ask "were you in it?".
  - `double_booked`: two meetings at the same time and one call. Ask which one
    it was. Marking one attended makes the other not attended (basis
    `double_booked`); marking one not attended gives the call to the other.
- `unknown` (basis `no_call_data`): no call data for that time (calls are
  watched only while outside activity is on). Say so.

`summary.meetingMin` is the attended meeting time, each second once (two
overlapping meetings never count the same call twice, and the call under a
double booking counts though which meeting it was is open); `summary.meetings` counts
each attendance. Meetings the user asked to leave out (`time_meetings_ignore_set`)
are not checked (`summary.ignoredMeetings`).

## 4. How the timeline decides, and how sure it is

For each minute the activity with the highest source priority wins: Walnut 100,
Mac apps 90, calls 85, sleep 70, workouts 60, calendar 50, a plugin 40 (never
above 80).
Places say where and never compete. Screen time joins into one `screen` block
across gaps up to 10 minutes; a hole of 15 minutes or more is a `gap` block,
labelled with the place when Places knew it, or `travel?` between two places.

Every block carries `confidence`: `measured`, `planned` or `inferred`. In the
report, say "about" for inferred minutes and never present a plan as something
that happened.

## 5. Recipes

### A. "Where did my time go this week?"

1. Settle the window first. "Last week" can mean the previous Monday to Sunday or
   the last seven days: when the context does not make it clear, ask in one
   line; when you must go on, say the dates in your first sentence.
2. `time_report` with `group_by: "day,task,project,app,hour"` for the window.
3. Split the time into a few buckets the user recognises (their projects, or
   areas such as ops, meetings, reviews, deep work, admin, chat). A bucket can
   span several Walnut projects; say which projects and tasks went into it.
4. For each bucket: work hours and whole day, and its share of work hours.
5. Evenings and weekends: `offMin` per day; name the days that ran late.
6. Scatter: `fragmentation` (tasks per day, switches per hour, `deepShare` = the
   share of time in stretches of 45 minutes or more, the longest stretch).
7. Where the work came from, with each row's `createdBeforeRange` and `source`:
   - carried over: the task existed before the window;
   - inbound: created in the window by a sync plugin (`source` set: a ticket
     or item from another system), or asked for by someone (check `task_get`
     when the title does not say);
   - self-started: created in the window in Walnut.
   This is an estimate; ask about the borderline ones instead of guessing.
8. Decisions waiting on the user: tasks in `NEED_ACTION`, or a large share
   spent on something the user may want to hand off or stop.
9. Write the answer (section 6) and save it (section 8).

### B. "Why didn't X finish?"

1. Find the task (`task_list` / `search`), then `time_report` over the days it
   was open with `group_by: "day,task"`: how many minutes it got, on which days,
   in work hours or after.
2. What took its place: the top tasks and apps on the days it got little.
3. `time_timeline` for the one or two days that should have been its days:
   meetings, gaps, a late start after a short night.
4. Its own story: `task_get` (blockers, waiting on someone, agent time spent
   without the user's review).
5. Answer in one line first ("It got 40 minutes in five days; ops took the
   mornings"), then the evidence, then what would change it.

### C. "Did I keep my plan today?"

1. `time_timeline` for today (`partial: true` until the day is over).
2. Read `plan`: each planned block with its `verdict`:
   `kept` (the named task had at least half the block), `partly`,
   `other_work` (on screen, on something else), `meeting_on_screen`,
   `not_on_screen` (away, or doing something the Mac cannot see).
   A planned block is matched to a task by a task id in its title, or by two
   shared title words (short names such as "CIS" and CJK words count).
   For a meeting, read `attendance` (section 3b), not the verdict: the verdict
   only says what the screen showed.
3. Report kept blocks, moved blocks and what took their place, then the
   unplanned time that mattered. Ask about `not_on_screen` blocks rather than
   calling them missed.

## 6. Writing the answer

- Conclusion first, in the user's language: two or three sentences that answer
  the question. Then the evidence.
- Plain lists, not tables: the user often reads on the phone.
- Name the window and the work hours you used.
- Report time in hours with one decimal ("Ops 12.1 h", "0.4 h"), never as a
  minute total: people do not think in hundreds of minutes. Say "about" for
  inferred time.
- Go one level below each bucket: the themes inside it with their top tasks and
  hours; for chat apps, the channels, the kind of messages and how many
  half-hours of the day they touched; for meetings, the recurring ones versus
  the one-offs, each with hours; for the browser, the sites.
- When the user keeps goals (a goals note), close with advice tied to them:
  each item names the hours it would save and, where it helps, the free slots
  on the calendar.
- End with what needs the user: a decision, a question about a gap, a task to
  hand off. Keep it to the few that matter.

## 7. Lessons from earlier reviews

- A high share of ops work does not mean an on-call week. Check the calendar or
  the tasks for an on-call rotation, or ask; never state it as fact.
- Confirm the window when the user says "last week".
- Session minutes are the user's attention; agent minutes cost none. Mixing them
  inflates the user's day.
- A workout overlapping sleep is a watch left running, not a night of exercise.
- Make the parts add up. `attentionMin` = `walnutMin` + `readingMin` +
  `outsideMin`, and each second is in one of them only (the overlap a lease
  used to run into another app is cut and shown as `overlapMin`). Calls and
  meetings overlap screen time. When the user asks "how many hours did I have
  and where did they go", count each second once (frontmost app, then the Walnut
  task, then the off-screen part of a call or attended meeting, then sleep or a
  workout, then short pauses and longer away time), so the slices sum to the
  window, and show it per day as well as per week.
- A gap is not idleness: it can be a meeting room, a walk, a talk at a desk.
  Say what is known (the place, the calendar), then ask.

## 8. Privacy, and saving the report

- Everything stays local. Never copy coordinates, addresses or raw health
  values into a task, a note, a board or anything that syncs, unless the user
  asks. Write "at the office", "a short night", "a 45-minute run".
- A report is a deliverable: save the final report in the notes vault, in the
  time-review topic the vault already has. Never start a second home for it.
  1. Follow the vault's own routing first: when the vault root has an
     `AGENTS.md` (or a README that indexes topics), read it with `note_read`
     and use the topic it names.
  2. Otherwise find the topic: `note_search` for "time-review" and for
     "time reviews", and look at the PATHS of the hits for a folder named like
     time-review, time-reviews or time review, at any depth, in any case. When
     several match, take the one with a `README.md`.
  3. Write into that folder and follow its README: its file names, where it
     keeps attachments (an HTML report, charts), and its line format. Add one
     dated line with the conclusion to its README
     (`- 2026-10-10: week of 10-05: ops took 38% of work hours; two deep blocks.`).
  4. Only when no such topic exists, create `time-review/README.md` at the vault
     root (one line on what the folder holds, then the dated lines) and write
     the report as `time-review/<YYYY-MM-DD>-<short-name>.md` with `note_write`.
  A copy in a scratch directory alone is not saved.
