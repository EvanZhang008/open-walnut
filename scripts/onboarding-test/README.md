# Fresh-machine onboarding test

This harness answers one question: if somebody who has never seen Walnut follows the README on a machine that has never seen Walnut, what actually happens? It provisions a throwaway machine, does exactly what the README says (`git clone`, `npm install`, `npm start`, and separately `npm install -g open-walnut`), times every step, screenshots the first-run page, writes down each place a brand-new user would have had to stop and figure something out, and then destroys the machine. It never repairs the product on the way: `probe.sh` only reports.

## The targets

| Target | Cost | Time to a usable machine | Fidelity | Needs on your side |
|---|---|---|---|---|
| `mac-vm` | free | about 2 minutes | highest for a Mac user: stock macOS with no Homebrew, no Xcode Command Line Tools, no git, no node | Apple Silicon, `brew install cirruslabs/cli/tart sshpass`, and `tart pull ghcr.io/cirruslabs/macos-sequoia-vanilla:latest` (about 24 GB, once) |
| `linux` | EC2 t3.large, about USD 0.08 per hour | about 2 minutes, plus a minute for the SSM agent to register | a clean server distro (`al2023`, `al2023-arm` or `ubuntu`), reached only through SSM: no ingress, no SSH key, no public endpoint | `awscli` plus `session-manager-plugin`, and credentials for an account you are happy to spend in |
| `mac-ec2` | a mac2.metal is sold as a whole physical host and bills a 24 hour minimum, about USD 16 | 5 to 15 minutes before SSM answers | real Apple hardware, so the closest thing to a new laptop that is not on your desk | account eligibility for Mac hosts; without it `AllocateHosts` fails with `UnsupportedHostConfiguration`, which a support case unlocks |
| `remote-host` | free (a local container, or the CI job `remote-host`) | about 1 minute to build and start, plus a minute for Walnut's own Bun install on the box | the second machine: a Linux dev box with no C compiler, no node, an npm-built `claude` and `~/workplace` symlinked to `/workplace`, reached over real ssh | Docker with a running daemon; `npm install`, and `npm run build:daemon` for the daemon sidecars |

`mac-vm` is the one to reach for by default: it is free, it is the fastest, and a vanilla image is genuinely bare. Use `linux` when the question is about a server install, and `mac-ec2` only when the Mac VM cannot answer the question, because the 24 hour charge starts the moment the host is allocated.

## The second machine: remote host

Everything above tests the machine the server runs on. `remote-host/` tests the other one: a Linux dev box a user adds as a remote host, which Walnut has to provision on its own. The box is a container (`remote-host/Dockerfile`) shaped like a real one that broke for a new user: no C compiler, no node on the non-interactive ssh PATH, `~/.local/bin/claude` linked to an npm `cli.js` whose shebang is `#!/usr/bin/env node`, and `~/workplace` a symlink to `/workplace` next to a real `~/workspace`. `sudo` is installed but alice has no sudoers entry, like a user who cannot sudo without a password. Bun is deliberately absent, because installing it there is Walnut's job.

```bash
scripts/onboarding-test/remote-host/run.sh          # build, start, test, tear down
scripts/onboarding-test/remote-host/run.sh --keep   # leave the container up to poke at
```

`run.sh` builds the image, makes a throwaway ed25519 key in a private temp dir, starts the container with sshd on a random loopback port, writes an ssh config that maps the alias `walnut-onboarding-devbox` to it, and runs `tests/live/remote-host-onboarding.live.test.ts`. On exit it removes only the container it started and its own temp dir. Without Docker (or with the Docker daemon stopped) it exits 1 and says so. The test drives the real `DaemonConnection` through every connect step (ssh, probe, install-runtime, upload, start, tunnel, handshake), then checks the folder picker's `~/workplace` and `~/workspace`, the terminal, `host.preflight`, and the message a session start gives when `claude` needs a node the box does not have. Those steps check diagnosis only, so the test runs with `WALNUT_HOST_AUTOFIX=0`: an automatic fix would change the answers they pin. The terminal check has two branches, and the test log says which one ran (`branch: prebuilt` or `branch: no_compiler`). `npm run build:daemon` on a Linux machine with gcc (the amd64 CI runner) writes `dist/daemon-binaries/dtach-linux-x64`, which Walnut uploads to the box, so the terminal is persistent and `host.preflight` finds dtach at `~/.local/bin/walnut-dtach`. On a Mac there is no prebuilt for the arm64 container, so the terminal is a plain shell that names the missing compiler. With `WALNUT_REMOTE_ONBOARDING_AUTOFIX=1` (the CI job sets it) a final step reconnects with autofix on and waits up to 6 minutes for `host.fix` to install the native Claude Code and, in the no-compiler branch only, to report that the gcc install needs a sudo password (once dtach runs, a compiler is pointless and Walnut never asks for sudo), then checks that a fresh preflight sees the native build. Walnut's host config has no ssh-config or key option, so the test registers the host as `hosts.devbox.hostname: walnut-onboarding-devbox` in an isolated `config.yaml` and puts an `ssh` shim first on PATH that adds `-F <that config>`. It refuses to run unless the alias resolves to loopback and the box carries `/etc/walnut-onboarding-fixture`. CI runs the same script in the `remote-host` job, which is part of `CI OK`. Because that job needs the network twice (the base image from Docker Hub, and Bun from bun.sh on the box), the step runs `run.sh` up to two times, each attempt capped at 12 minutes, and uploads both attempts' logs as the `remote-host-logs` artifact, so a pass on the retry still shows why attempt 1 failed. A failure caused by a download is labelled: `run.sh` prints `NETWORK:` when the image pull or apt fetch fails, and the live test fails with `NETWORK:` when Bun never got installed and the box cannot reach bun.sh or GitHub, or when the native Claude Code install failed and the box cannot reach claude.ai or its download bucket (or the error names a download failure). Those lines are copied to the job summary; any other failure is a real regression. The base image is pinned by digest (the bump command is in the Dockerfile), so when Docker Hub refuses it (its anonymous pull limit counts a hosted runner's shared address), `run.sh` takes the same digest from `mirror.gcr.io` or `public.ecr.aws` instead. Ratchet: `tests/scripts/remote-host-onboarding-ratchet.test.ts`.

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
