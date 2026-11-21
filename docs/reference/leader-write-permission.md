# The leader's write permission

Only one machine at a time may act as a Walnut's leader: write its data, run its timers and
triggers, and send anything outward (mail, chat, push). The write permission is what makes
"one at a time" true when the leader can move between machines, by hand or by itself. Code:
`src/core/leader/permit/`. **It is wired to nothing yet**: no server, daemon or route
imports it, so it changes no running behaviour. The wiring comes after the server and daemon
merge.

## The record

One numbered record per Walnut, kept by a fixed list of witnesses (three always-on machines,
a majority of two). A record is `{ number, kind, holder, by, from, to, validMs, list }`:

| kind | written by | gives the permission to | a witness takes it when |
|---|---|---|---|
| `grant` | the asker | the asker | the record it holds ran out on its own clock, plus `witnessMarginMs` |
| `renew` | the holder | the holder | it still holds the holder's record |
| `handover` | the holder | `to` | it still holds the holder's record (not a handover) |
| `cancel` | the old holder | the old holder | it holds that holder's handover, or the holder's live record |
| `members` | the holder | the holder | as a renew; it carries the new witness list |

Every witness takes only a number above the one it holds, so a duplicate, a replay or a late
old record never lowers it. It writes the record to disk (file fsync, rename, directory fsync)
before it answers yes; a file that is torn or fails its checksum makes it refuse everything,
loudly, and is never read as "no record". A witness with no file at all is not set up: it
waits to join through a members record (`bootstrapWitnessStore` sets up a new witness once and
refuses a store that already has a file).

## When a machine may act

A machine acts only on a record of its **own** that a majority of the **fixed** list accepted,
never a majority of whoever answered. It counts that record for `validMs - holderMarginMs` from
the moment it first **sent** it, on its own clock. A witness keeps the record for its holder
for `validMs + witnessMarginMs` from the moment it **accepted** it, on its own clock, and only
then grants to someone else. No clock reading ever crosses the network: a clock that is 30 s
or an hour off changes nothing.

- `mayAct()` is cheap and synchronous: it reads that deadline against the clock.
- `assertMayAct(opId)` is what an outward send will call first. It also refuses with less than
  `minSendRemainingMs` (15 s) left.
- A late answer is never counted: a yes that arrives after the deadline counted from the send
  adds nothing, and a renew that reaches a witness after its hold ran out is refused.
- No answer is never a yes. A machine that is unsure reads the witnesses back (`read`,
  `standing()`: the record a majority holds, or "unknown").

## Clocks and their assumption

The holder's clock must never run slow, a witness's never fast:

- **Holder**: each step counts the larger of the monotonic and the wall-clock time passed
  (`createHolderClock`). A plain monotonic clock stops while the machine sleeps (macOS and
  Linux leave suspend out of it): a laptop waking from a 90 s sleep would otherwise act on a
  permission that ran out on the witnesses. With the wall clock in, it wakes with `mayAct()`
  false at once. A wall clock set back costs nothing; one set forward ends the permission early.
- **Witness**: the monotonic clock alone (`createWitnessClock`); a pause only makes it wait
  longer. After a restart it counts the record it holds as accepted at the restart.

**Assumption: no clock's rate is off by more than `maxDriftRate` (2% by default).** With a
holder lease `L = validMs - holderMarginMs` and a witness hold `W = validMs + witnessMarginMs`,
it is safe while `L/(1-r) < W/(1+r)`, that is `r < (W-L)/(W+L)` (`maxSafeDrift`: 3.3% for the
defaults, 60 s valid and 2 s margins). `checkTiming(params)` refuses parameters whose margins do
not cover the assumed rate. Real clocks drift by well under 0.1%; the margin is for VMs and
hosts whose time service corrects in steps.

## Manual switch: handover and cancel

The holder stops acting first (`handover(to)` makes `mayAct()` false at once), then writes the
handover. The new holder acts only after a renew of its own on top of the handover reaches a
majority. The old holder resumes only by getting a cancel of its own accepted: "a majority
still shows my old record" is not enough, since the handover may be half written. A handover
and a cancel cannot both stand: at the witness both majorities share, whichever came first
blocks the other (a cancel never stands on the new holder's renew, and the new holder's renew
never stands on a cancel).

## Changing the witness list

The list changes only through a `members` record that a majority of the old list **and** a
majority of the new list accepted. A witness that took it serves only the new list from then
on; one that is not on it refuses everything. When only one majority took it, the holder sends
the same change again (or the reverse one) and the witnesses that already moved take it too.

## Automatic takeover (rule only)

`mayAskForTakeover` is a pure function of one read round, unused for now. A candidate may ask
for the permission only when a majority of the fixed list says the old one ran out, and its
standby copy is provably no further behind than `maxBehindMs` (design: 5 minutes). The proof is
the old holder's progress stamp (`progress: { seq, writtenAt }`, carried on its records) against
the copy's newest write, plus one whole lease for what it may have written after the stamp. No
stamp means no proof: it refuses.

## How it is tested

`tests/core/leader/permit/`: a simulated world (one real timeline; each node its own clock with
drift, offset, wall jumps and sleeps; a network that delays, drops, duplicates and reorders;
witnesses that crash and restart from their file). `model-check.test.ts` runs about 900 seeded
15-minute schedules against one invariant (at no real instant do two machines both have
`mayAct()` true), plus negative controls that each remove one safety part (the margins, the
fsync before the answer, the wall clock in the holder's clock, the fixed-list majority) and
must find a violation. `named-cases.test.ts` holds the named schedules (the split, the 90 s
sleep, a witness killed between accepting and answering, clocks 30 s off and 1% fast or slow,
the drift bound's edge, late renews, the handover and cancel race, one witness reachable, the
list change).

## Not built yet

- **The wiring**: the witness service on the three always-on machines, a transport over the
  existing links, the holder's renew loop, the boot path, and `assertMayAct` before every
  outward send. When it is wired it replaces the companion's takeover decision
  (`src/core/leader/takeover.ts`, which counts the hosts it can reach and has no fixed
  majority) and the `primary | backup` holder of the daemon's leader book
  (`src/providers/leader-core.ts`); the book's epoch stays as the fence a host checks on each
  command.
- **Registering an outward send's operation id with the witnesses** before it goes out, so a
  new holder lists "registered, no result" sends as unknown instead of sending them again
  (design section 6).
- The old holder's handover flag survives only in memory: a restarted process comes back with
  no permission and must renew, which is safe, but the manual-switch flow must keep its own
  "switch in progress" state on disk.
- Liveness under contention: candidates that ask at the same instant can split the witnesses
  and wait a whole hold for the next try; the wiring needs a random back-off.
