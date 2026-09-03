# Fresh-machine onboarding test

This harness answers one question: if somebody who has never seen Walnut follows the README on a machine that has never seen Walnut, what actually happens? It provisions a throwaway machine, does exactly what the README says (`git clone`, `npm install`, `npm start`, and separately `npm install -g open-walnut`), times every step, screenshots the first-run page, writes down each place a brand-new user would have had to stop and figure something out, and then destroys the machine. It never repairs the product on the way: `probe.sh` only reports.

## The three targets

| Target | Cost | Time to a usable machine | Fidelity | Needs on your side |
|---|---|---|---|---|
| `mac-vm` | free | about 2 minutes | highest for a Mac user: stock macOS with no Homebrew, no Xcode Command Line Tools, no git, no node | Apple Silicon, `brew install cirruslabs/cli/tart sshpass`, and `tart pull ghcr.io/cirruslabs/macos-sequoia-vanilla:latest` (about 24 GB, once) |
| `linux` | EC2 t3.large, about USD 0.08 per hour | about 2 minutes, plus a minute for the SSM agent to register | a clean server distro (`al2023`, `al2023-arm` or `ubuntu`), reached only through SSM: no ingress, no SSH key, no public endpoint | `awscli` plus `session-manager-plugin`, and credentials for an account you are happy to spend in |
| `mac-ec2` | a mac2.metal is sold as a whole physical host and bills a 24 hour minimum, about USD 16 | 5 to 15 minutes before SSM answers | real Apple hardware, so the closest thing to a new laptop that is not on your desk | account eligibility for Mac hosts; without it `AllocateHosts` fails with `UnsupportedHostConfiguration`, which a support case unlocks |

`mac-vm` is the one to reach for by default: it is free, it is the fastest, and a vanilla image is genuinely bare. Use `linux` when the question is about a server install, and `mac-ec2` only when the Mac VM cannot answer the question, because the 24 hour charge starts the moment the host is allocated.

## Commands

```bash
scripts/onboarding-test/run.sh mac-vm
scripts/onboarding-test/run.sh linux --os al2023 --type t3.large
scripts/onboarding-test/run.sh mac-ec2 --yes-mac-host        # allocates a 24h-billed host

# flags shared by all three targets
#   --path readme,npm        which documented install path(s) to walk
#   --ref main               git ref to clone
#   --pkg open-walnut@latest what `npm install -g` should fetch
#   --ttl-hours 3            after this, a later sweep is allowed to kill the machine
#   --ready-timeout 900      how long to wait for the server to answer
#   --keep                   leave the machine up to poke at
#   --record                 also render the whole run as one mp4

scripts/onboarding-test/run.sh status                        # what is up right now
scripts/onboarding-test/run.sh sweep [--all] [--release-hosts]
scripts/onboarding-test/run.sh release-host                  # hand an idle Mac host back
```

Full help is the file header: `run.sh <target> --help` (a target has to come first, because a bare word is read as the target).

## What comes back

Everything for one run lands in `/tmp/walnut-onboarding-test/<run-id>/`:

- `summary.txt` and `report.md`: a table of every step with its status (`ok`, `fail`, `skip`) and wall-clock seconds, then the findings list. A **finding** is the point of the whole exercise: one sentence per place the documented path made a new user guess, wait without explanation, or stop. Example: a brand-new Mac has no git, so `git clone` pops the Command Line Tools installer, and the README does not mention it.
- `steps.jsonl`: the same steps as one JSON object per line (`name`, `status`, `seconds`, `note`, `finding`, `log`), which is what the summary is rendered from.
- `logs/NN-step.log`: the full output of each step, so a failure can be read rather than guessed at.
- `first-run-<path>.png`, `-banner.png`, `-settings.png` plus `first-run-<path>.json`: the setup banner as a new user sees it, which of its three states appeared, page load time, and any console errors.
- `probe.out`: the probe's live narration, exactly as it streamed into your terminal.

## The `--record` video

`--record` re-runs the same invocation under `asciinema`, so the provisioning narration and the probe's own output land in one `terminal.cast`. `render-video.sh` then turns that into `terminal.mp4` with `agg` and `ffmpeg`, clipping idle stretches to 2 seconds so a 10 minute `npm install` reads as a short story. The browser clips come from `capture.mjs`, which drives the first-run page with Playwright at a slower pace and records `browser-<path>.mp4`. All the pieces are normalised to 1280x800 at 30 fps and concatenated into `onboarding-<target>.mp4`. Needs `asciinema`, `agg` and `ffmpeg`; if `agg` or `ffmpeg` is missing the run keeps the `.cast` and says so instead of failing.

## Cleanup guarantees

- Every resource is registered for teardown in the same function that creates it, and the stack runs in reverse on an EXIT trap, so a crash or a Ctrl-C at any point still tears down what already exists.
- Every cloud resource carries the tag `walnut-onboarding-test=<run-id>` plus a TTL tag, so anything a hard-killed run left behind is still findable.
- `run.sh sweep` terminates every tagged instance past its TTL, and a `linux` or `mac-ec2` run sweeps before it provisions. `--all` ignores the TTL and takes everything tagged, so do not pass it while somebody else has a run in flight. `--release-hosts` also hands back idle Mac hosts.
- `--keep` opts out of teardown for the machine only. Clean up afterwards with `run.sh sweep --all` (cloud) or `tart delete <vm>` (mac-vm).
- The probe's `--stop` signals only the PIDs it wrote down itself, with a `pid > 1` floor, and only ever sends `TERM`. It never signals a process group, and it never touches anything it did not start.

## IAM footprint

One role, `walnut-onboarding-test-ssm`, with exactly one attached policy, `AmazonSSMManagedInstanceCore`, and no inline policy. The role is created on first use if it is absent. Instances get that role as their instance profile, require IMDSv2, and are launched with no key pair, no security group of your choosing and no public IP association: the only path in is SSM, and the only path out for results is `send-command` and a port forward on localhost. AMI ids are never hardcoded; each `--os` maps to a public SSM parameter that is resolved at run time, so a run always gets the current image. The caller identity is checked but never printed, because the ARN carries the account id and this output ends up in recorded videos.
