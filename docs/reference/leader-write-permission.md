# The leader's write permission

Only one machine at a time may act as a Walnut's leader: write its data, run its timers and
triggers, and send anything outward (mail, chat, push). The write permission is what makes
"one at a time" true when the leader can move between machines, by hand or by itself. Code:
`src/core/leader/permit/`. **It is wired to nothing yet**: no server, daemon or route
imports it, so it changes no running behaviour. The wiring comes after the server and daemon
merge.

## The record

One numbered record per Walnut, kept by a fixed list of witnesses (three always-on machines,
a majority of two). A record is `{ number, kind, holder, by, nonce, from, to, validMs, list, cfg, progress }`
(`cfg`: which configuration of the witness list, below; `nonce`: the writer's incarnation):

| kind | written by | gives the permission to | a witness takes it when |
|---|---|---|---|
| `grant` | the asker | the asker | the record it holds ran out on its own clock, plus `witnessMarginMs` |
| `renew` | the holder | the holder | it still holds the holder's record |
| `handover` | the holder | `to` | it still holds the holder's record (not a handover) |
| `cancel` | the old holder | the old holder | it holds that holder's handover, or the holder's live record |
| `members` | the holder (or anyone, as a grant) | the writer | as a renew, or as a grant once the record ran out; it changes the witness list in two steps (below) |

Every witness takes only a number above the one it holds, so a duplicate, a replay or a late
old record never lowers it. It writes the record to disk (file fsync, rename, directory fsync)
before it answers yes; a file that is torn or fails its checksum makes it refuse everything,
loudly, and is never read as "no record". A witness with no file at all is not set up: it
waits to join through a members record (`bootstrapWitnessStore` sets up a new witness once and
refuses a store that already has a file).

## When a machine may act

Every record carries its writer's **incarnation** (`nonce`, random per process start), and a
machine counts a witness's yes only when that witness holds this very record, nonce included.
A process that restarted proposes numbers it may have used before; without the nonce a yes a
witness gave the old record (or a late `ok` answering the old number) would be counted from the
new send, and the lease would outlive the witness's hold (review round 1 found it).

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
  false at once. A wall clock set forward ends the permission early. A wall clock set back
  by more than 1 s in one step ends the permission held now, since it may hide a sleep (the
  random schedules found a sleep of 88 s under a set-back of 100 s, stress seed 3564).
- **Witness**: the monotonic clock alone (`createWitnessClock`); a pause only makes it wait
  longer. After a restart it counts the record it holds as accepted at the restart.

**Assumptions.** (1) No clock's rate is off by more than `maxDriftRate` (2% by default).
(2) While a holder sleeps, its wall clock is not set back by nearly as long as the sleep lasted
(within 1 s): such a step hides the sleep from both clocks. The wiring should pass a clock that
counts suspend where the platform has one (Linux `CLOCK_BOOTTIME`, macOS
`mach_continuous_time`) as the monotonic source, which removes (2).
For (1): With a
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

The list changes in two steps (joint consensus), never in one:

1. **The pair step** (`members`, stage `joint`): a witness that takes it serves the pair (old
   list, new list) from then on, and takes only records judged by both; such a record counts only
   with a majority of the old list **and** a majority of the new one. A witness never goes back
   from the pair to the old list alone.
2. **The final step** (stage `final`): sent only once a pair record reached both majorities. A
   witness that takes it serves the new list alone; one that is not on it refuses everything
   until a later change names it again.

**Every configuration has an id** chained from the first list through each change
(`genesisConfigId`, `nextConfigId`), and every record names the id it is judged by. The same
list can come back after changes (w1,w2,w3 then w2,w3,w4 then w1,w2,w3 again); only the id tells
a witness that followed the changes from one that slept through them, which the random schedules
also found (stress seed 1754) before the id existed. A witness waiting to join takes a change
only into the new list, never as a member of the old one: a witness that left a list, or lost its
disk, never counts for it again (stress seed 1309).

Why two steps: in one step, a witness that took a change no majority of the old list had
confirmed would serve the new list at once, and a majority of the new list could then form
beside a majority of the old one, with no witness in common. The random schedules found exactly
that (seed 12 of the list-change sweep) before the second step existed. Once a pair record
counted, a majority of the old list sits in the pair, so no old-list majority can form again.

`changeWitnesses(newList)` sends the pair step and then the final step by itself; called again
while the pair stands, it sends the final step again. A machine sends the final step only when it
knows the pair stands: its own pair record reached both majorities, or a read showed a majority of
each list in that pair (or past it, by id). A pair it only learned of from a read may still be
held by a minority of the old list. A change its holder left half done is
finished by any machine once the permission ran out (`changeWitnesses(newList, { list, cfg })`). Two
different changes started from the same list at once leave the witnesses of the one that did not
count stuck in its pair; that is safe but needs a repair step (not built).

## Automatic takeover (rule only)

`mayAskForTakeover` is a pure function of one read round, unused for now. A candidate may ask
for the permission only when a majority of the fixed list says the old one ran out, and its
standby copy is provably no further behind than `maxBehindMs` (design: 5 minutes). The proof is
the highest progress stamp (`progress: { seq, writtenAt }`, carried on the holder's records)
against the copy's newest write, plus one whole lease for what it may have written after the
stamp. Each witness keeps the highest stamp it ever took, so a contending grant that carries an
older stamp, or none, neither hides how far the last real holder wrote nor blocks the other
candidates. No stamp means no proof: it refuses.

## How it is tested

`tests/core/leader/permit/`: a simulated world (one real timeline; each node its own clock with
drift, offset, wall jumps and sleeps; a network that delays, drops, duplicates and reorders;
witnesses that crash and restart from their file). `model-check.test.ts` runs about 700 seeded
15-minute schedules (some with witnesses swapped in and out of the list, some with the holder restarting mid-renew) against one invariant (at no real instant do two machines both have
`mayAct()` true), plus negative controls that each remove one safety part (the margins, the
fsync before the answer, the wall clock in the holder's clock, the fixed-list majority) and
must find a violation. `named-cases.test.ts` holds the named schedules (the split, the 90 s
sleep, a witness killed between accepting and answering, clocks 30 s off and 1% fast or slow,
the drift bound's edge, late renews, a holder restarting mid-renew, the handover and cancel race, one witness reachable, the
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
- **One process per machine id** is a precondition of the wiring: the witnesses tell holders
  apart by machine id, so two live processes with one id (a deploy that boots the new server
  before the old one exits) would share one permission. The wiring takes an OS-level
  single-instance lock before it makes a `PermitClient`.
- The old holder's handover flag survives only in memory: a restarted process comes back with
  no permission and must renew, which is safe (its records carry a new incarnation), but the
  manual-switch flow must keep its own "switch in progress" state on disk.
- Repairing witnesses left in the pair of a list change that never counted (two changes
  started at once): safe, but they stay out of service until a repair step exists.
- Liveness under contention: candidates that ask at the same instant can split the witnesses
  and wait a whole hold for the next try; the wiring needs a random back-off.
