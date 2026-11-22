# The leader's write permission

Only one machine at a time may act as a Walnut's leader: write its data, run its timers and
triggers, and send anything outward (mail, chat, push). The write permission is what makes
"one at a time" true when the leader can move between machines, by hand or by itself. Code:
`src/core/leader/permit/`. **It is wired to nothing yet**: no server, daemon or route
imports it, so it changes no running behaviour. The wiring comes after the server and daemon
merge.

## The record

One numbered record per Walnut, kept by a fixed list of witnesses (three always-on machines,
a majority of two). A record is `{ number, kind, holder, by, nonce, from, to, validMs, list, cfg, epoch, progress, clock }`
(`cfg`: which configuration of the witness list, below; `nonce`: the writer's incarnation;
`clock`: which clock the writer counts its lease on), and a renew may carry op ids (`ops`, below):

| kind | written by | gives the permission to | a witness takes it when |
|---|---|---|---|
| `grant` | the asker | the asker | the record it holds ran out on its own clock, plus `witnessMarginMs` |
| `renew` | the holder | the holder | it still holds the holder's record, written by the same incarnation (or a handover to it) |
| `handover` | the holder | `to` | it still holds the holder's record of the same incarnation (not a handover) |
| `cancel` | the old holder | the old holder | it holds that incarnation's handover, or its live record |
| `members` | the holder (or anyone, as a grant) | the writer | as a renew, or as a grant once the record ran out; it changes the witness list in two steps (below) |

Every witness takes only a number above the one it holds, so a duplicate, a replay or a late
old record never lowers it. It writes the record to disk (file fsync, rename, directory fsync)
before it answers yes; a file that is torn or fails its checksum makes it refuse everything,
loudly, and is never read as "no record". A witness with no file at all is not set up and takes
nothing: `bootstrapWitnessStore` sets up the first witnesses with the first list, and
`prepareJoiningWitness(store, epoch, current)` sets up a new witness, or one that lost its disk, to join
through a list change from generation `epoch` on. The generation comes from the witnesses, not
from a person: `generationToJoin(reads)` gives the highest one any set-up witness reports, and a
generation below `current` is refused (one below the current generation could let it join an
older configuration). Both refuse a store that already has a file.

## When a machine may act

Every record carries its writer's **incarnation** (`nonce`, random per process start), and a
machine counts a witness's yes only when that witness holds this very record, nonce included.
A process that restarted proposes numbers it may have used before; without the nonce a yes a
witness gave the old record (or a late `ok` answering the old number) would be counted from the
new send, and the lease would outlive the witness's hold (review round 1 found it).

A witness also takes a renew, handover, cancel or list change from the holder only when its
**incarnation** matches the record it holds: another process of the same machine (a second
server started beside the first, or one restarted while the old one still runs) is another
holder, and waits for the permission to run out like any other machine. So two processes of one
machine can never both hold it (the random schedules run two processes per machine; with one
shared incarnation they go red). A restarted process therefore waits out its old permission
before it holds again.

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

- **Holder**: a plain monotonic clock stops while the machine sleeps (macOS and Linux leave
  suspend out of it): a laptop waking from a 90 s sleep would otherwise act on a permission
  that ran out on the witnesses. `createHolderClock()` counts on the machine's clock that
  includes sleep: Linux `CLOCK_BOOTTIME`, macOS `mach_continuous_time`, read through libc with
  bun:ffi (`system-clock.ts`, about 0.4 us a read on Linux and 0.03 us on an Apple silicon Mac,
  no I/O, so it never blocks the event loop). Each step counts the largest of its advance, the
  monotonic clock's, and the wall clock's when it went forward: inside a virtual machine whose
  host was suspended or paused, the guest's boot clock may not count the pause, while its wall
  clock is put right after it. A wall clock set forward then only ends the permission early; one
  set back changes nothing. Where that clock
  cannot be read (Node, Windows, a 32-bit build) it falls back to the larger of the monotonic and
  the wall-clock time passed, and every record says so: `clock: 'mono-wall'` (else `'boottime'`
  or `'continuous'`). On the fallback a wall clock set forward ends the permission early, and one
  set back by more than 1 s in one step ends the permission held now, since it may hide a sleep
  (the random schedules found a sleep of 88 s under a set-back of 100 s, stress seed 3564).
  The mark only informs: a witness takes a kind it does not know yet (a newer holder, up to 32
  characters), so an upgrade never splits holders from older witnesses.
- **Witness**: the monotonic clock alone (`createWitnessClock`); a pause only makes it wait
  longer. After a restart it counts the record it holds as accepted at the restart.

**Assumptions.** (1) No clock's rate is off by more than `maxDriftRate` (2% by default).
(2) Only on the fallback clock: while a holder sleeps, its wall clock is not set back by nearly
as long as the sleep lasted (within 1 s), since such a step hides the sleep from both clocks.
The sleep-counting clock removes (2): a named case sleeps 90 s with the wall set back 90 s, and
only the fallback wakes still acting. A VM pause that neither the boot clock nor the wall
clock counts is outside both, as is a pause of the witness's own machine that its monotonic
clock skips (that only makes it wait longer). What was checked where: on Linux the tests read
`CLOCK_BOOTTIME` for real (it matches `/proc/uptime`); this host never suspends, so a real
sleep is not tested there, only simulated. On macOS the binding was run once on an Apple
silicon Mac (it loads, the timebase is 125/3, and continuous time ran 1253 minutes ahead of
absolute time: the Mac's sleep since boot); the module's own macOS tests use a stand-in
libSystem, and no test makes a Mac sleep.
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
disk, never counts for it again (stress seed 1309). Every configuration also has a **generation**
(`epoch`: how many changes led to it), which orders configurations where the chained id cannot.
A witness waiting to join takes a change only from its own generation (where it left, or what its
operator set up) or a later one: a late step of an older change could otherwise put it back into
a list that a majority, itself included, had already left, beside a straggler that never left it
(stress seed 8618, with five witnesses and steps arriving minutes late).

Why two steps: in one step, a witness that took a change no majority of the old list had
confirmed would serve the new list at once, and a majority of the new list could then form
beside a majority of the old one, with no witness in common. The random schedules found exactly
that (seed 12 of the list-change sweep) before the second step existed. Once a pair record
counted, a majority of the old list sits in the pair, so no old-list majority can form again.

`changeWitnesses(newList)` sends the pair step and then the final step by itself; called again
while the pair stands, it sends the final step again.

**The witnesses check that a final step's pair stood.** A final step carries `pairBy`: the
witnesses its writer saw hold the pair, from an answer to the pair record itself or any answer
showing that witness in the pair or past it (a witness's configuration only moves forward, so
what it once showed stays true). A witness refuses a final whose `pairBy` names no majority of
the old list, or none of the new one, or names a witness of neither, or names the witness
itself when it never took the pair. Witnesses cannot ask each other, so this is what they can
check: a client that sends the final too early (a bug) is refused, and a named case shows the
harm when it is not (the new witnesses take it, and one machine holds under the old list while
another holds under the new one). It does not stop a client that writes false names; the
names come only from answers the client received.

**A change left between its steps** (its writer stopped, or the pair reached only some
witnesses) is finished by `repairChange()`, from the latest read (`changePlan()` says what it
would do): the final step when the pair is known to stand; else the pair step again, but only
when a majority of each list answers and can take it; else nothing, and the plan names the
witnesses it waits for (`blocked`). It never pushes a pair whose new witnesses are gone: a
witness in a pair takes nothing the new list does not take too, so that would stop the
witnesses that still work. A change only goes forward: a pair is never turned toward another
new list, because once a pair stood its new witnesses may take its final step at any later
time, and a second pair beside it could end in two lists that do not overlap. The witnesses
take a repair from the live holder, or from anyone once the permission ran out;
`mayAskForTakeover({ joint })` decides when a candidate may (the witnesses in that pair count,
by both lists). A read also asks the new witnesses of a change in flight, so the plan knows
whether they answer. Two different changes started from the same list at once leave the
witnesses of the one that lost in its pair for good: set such a witness up again
(`prepareJoiningWitness` at the current generation) and bring it back through a later change.

## Automatic takeover (rule only)

`mayAskForTakeover` is a pure function of one read round, unused for now. A candidate may ask
for the permission only when a majority of the fixed list says the old one ran out, and its
standby copy is provably no further behind than `maxBehindMs` (design: 5 minutes). The proof is
the highest progress stamp (`progress: { seq, writtenAt }`, carried on the holder's records)
against the copy's newest write, plus one whole lease for what it may have written after the
stamp. Each witness keeps the highest stamp it ever took, so a contending grant that carries an
older stamp, or none, neither hides how far the last real holder wrote nor blocks the other
candidates. No stamp means no proof: it refuses. Two requirements on the stamp:

- `seq` is the Walnut data's own write sequence: one sequence for the Walnut, which a new
  holder continues from the copy it took over, never a counter of each machine's own.
- `writtenAt` is the writer's wall clock (`by` names the writer). The rule subtracts two stamps
  only when the same machine made both; a copy whose newest write another machine stamped is
  refused unless it already has the last `seq`, since minutes of clock offset would hide minutes
  of writes.

## Outward sends: op ids registered first (design section 6)

A mail or chat server does not know the permission's numbers, so a send that leaves after the
permission moved cannot be refused on the other side; 15 s of permission left does not promise
the send ends in time either. So before a send the holder registers its op id with the witnesses
(`registerOps(ids)`: a renew carrying `ops.register`; ids only, never content) and sends only
once `assertMaySend(opId)` passes: the permission as `assertMayAct`, and the registration taken
by a majority. Afterwards it reports the outcome (`reportOutcome(opId, sent)`, carried on the
next renew); `sent: false` only when the send surely never left. Use `beginSend(opId)` for the
send itself: it is `assertMaySend` plus a mark that this process started it, so a second call
throws. What this process began or reported stays in its memory for its whole life, so it
never sends one op twice, even after the witnesses dropped the entry.

Each witness keeps the entries (`registered`, `sent`, `not-sent`, with the registering
machine and incarnation) beside its record, on disk, and answers every request with them. It
takes a registration only from the live holder of the same incarnation, and refuses an id it
already holds unless it is that same incarnation sending it again with no outcome yet. Why a
registration that counted is never lost: every witness that took it took it before any later
holder's record (it refuses the registration once another machine's record is there), and any
majority of a later holder shares a witness with the registering majority. So a later holder's
answers carry the entry, and its own registration of the id is refused there. A list change
carries every entry its writer knows (`ledger` on the members records) to the witnesses that
join, so this holds across changes (a named case and a random sweep go red without it). An id
whose outcome is known is kept `opRetainMs` (1 hour, counted again from a witness restart),
longer than any standby copy may lag; one with no outcome stays until a holder reports it.
A witness holds at most 10,000 entries (`MAX_LEDGER_ENTRIES`); entries with no outcome are never
dropped, so the wiring must report outcomes and show the user the unresolved ones.

**The wiring's duty for outcomes it learns.** A holder that reads an op as `sent` or `not-sent`
(`learnedOutcomes()`) writes that outcome into the Walnut's own data before the entry can age out
(`opRetainMs`): after that only the data remembers it, and an op the data still lists as to send
would read `free` and be registered and sent again. The random sweeps model it (a holder that
reads `sent` marks the op done) and run past `opRetainMs` (a 10-minute retention over 25
minutes); a negative control that skips the mark sends ops twice.

A new holder reads the entries: `opStatus(id)` is `unknown` for an id registered by another
machine or an earlier process with no outcome: it is never sent again, and `unresolvedOps()`
lists them for the user to check. Once the user says what happened, `reportOutcome` records it.
An id is registered once: a retry after `not-sent` uses a new id.

## One process per machine

The witnesses already keep two processes of one machine apart (incarnations, above). The
**instance lock** (`acquireInstanceLock`) keeps a second process from even asking, frees itself
at once when its owner crashed, and stops an owner that comes back after another took over.
Each taking links a new generation file (`<path>.g<n>`) into place, complete: a link fails when
the name exists, so of all processes that try generation n, exactly one gets it, and the newest
generation never goes away (giving it up links a newer one that names no process), so no number
is taken twice. A generation is stale when its process is gone (a crash: taken at once; a pid is
only trusted inside its own pid namespace, so a process in a container is judged by its beats), or when
its owner has not beaten (`<path>.g<n>.<token>.beat`, every 5 s) for `staleAfterMs` (20 s) on the
machine's monotonic clock: a stopped or hung process. The machine's own sleep does not count, so
a laptop that slept keeps it. A generation also records the machine's boot id (Linux), so an
owner from an earlier boot is stale even when its pid was reused; and when neither its pid nor
its clock can be compared (another pid namespace on another clock kind), it is judged by the
wall clock with a wide limit (3 x `staleAfterMs`), so such a lock is never stuck for good. The
generation's directory entry is fsynced once linked; beats are not (a lost beat only looks
older). A file system without hard links is refused with a clear message. `held()` turns false
on its own once no beat has gone through for `staleAfterMs - beatEveryMs` (beats that fail to
write, a stopped process), a beat before another process may judge it stale; a failed beat
still checks. The owner checks every beat; one that finds a newer generation
calls `onLost`, and the wiring stops its `PermitClient` (`stop()`; the client also takes
`guard: () => lock.held()`, so `mayAct()` is false from that moment). Every step is asynchronous
file work. Tested with real processes: a crash, a process stopped with SIGSTOP and continued, and
eight takers at once in 40 random interleavings (exactly one wins; a single file removed by
whoever judged it stale lets two win).

## Back-off when candidates ask at once

Candidates that see the permission free at the same instant could split the witnesses (each
takes another candidate's grant first), and then all wait a whole hold before the next try,
again and again. `grantDelayMs()` is a random wait before a grant (full jitter): under
`backoffBaseMs` (2 s) before the first, doubling with each grant of this process that did not
stand, to `backoffMaxMs` (30 s); the candidate reads again after it and asks only if the
permission is still free. A named case puts three candidates each next to one witness, all
looking at the same instants: without the back-off no one holds in ten minutes, with it one
holds within a minute in each of 30 runs.

## How it is tested

`tests/core/leader/permit/`: a simulated world (one real timeline; each node its own clock with
drift, offset, wall jumps and sleeps; a network that delays, drops, duplicates and reorders;
witnesses that crash and restart from their file). `model-check.test.ts` (slow tier) runs about
1,300 seeded 15-minute schedules (some with witnesses swapped in and out of the list, some with
the holder restarting mid-renew or mid-change, some with five witnesses and change steps arriving
minutes late, some with two processes per machine, some sending outward ops) against two
invariants: at no real instant do two processes both have `mayAct()` true, and no op id is sent
by two processes. Negative controls each remove one safety part (the margins, the fsync before
the answer, the wall clock in the holder's clock, the fixed-list majority, waiting for the
registration, the ledger on list changes, the incarnation, the holder writing down an outcome it
read) and must find a violation. Each wake of a sleeping machine is an event of its own, so the
invariant is checked at the instant it wakes.
`named-cases.test.ts` holds the named schedules of the first brief (the split, the 90 s sleep, a
witness killed between accepting and answering, clocks 30 s off and 1% fast or slow, the drift
bound's edge, late renews, a holder restarting mid-renew, the handover and cancel race, one
witness reachable, the list change). `ops.test.ts`, `change-repair.test.ts`, `instance.test.ts`
and `system-clock.test.ts` hold the op ids, the final-step evidence and the repair, the back-off,
the two processes and the instance lock, and the clocks.

## Not built yet

- **The wiring**: the witness service on the three always-on machines, a transport over the
  existing links, the holder's renew loop, the boot path, and `assertMayAct` before every
  outward send. When it is wired it replaces the companion's takeover decision
  (`src/core/leader/takeover.ts`, which counts the hosts it can reach and has no fixed
  majority) and the `primary | backup` holder of the daemon's leader book
  (`src/providers/leader-core.ts`); the book's epoch stays as the fence a host checks on each
  command.
- **Wiring the op ids to the real send paths** (mail, chat, push): each send calls
  `registerOps`, waits, `assertMaySend`, sends, `reportOutcome`; and the list of unknown ops
  goes to the user's inbox. The core and its simulated sends are built; no send path calls it.
- **Wiring the instance lock** at the server's boot (its path under the Walnut's local data)
  and its `onLost` to the client's `stop()` and the process's exit.
- The old holder's handover flag survives only in memory: a restarted process comes back with
  no permission and waits it out, which is safe (its records carry a new incarnation), but the
  manual-switch flow must keep its own "switch in progress" state on disk.
- A witness left in the pair of a change that lost to another change started at once stays out
  of service until its operator sets it up again (above); no automatic step for that.
