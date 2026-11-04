# A host's daemon after a reboot

Every remote host runs Walnut's session daemon. Started the usual way (over SSH, when
Walnut connects), it does not come back by itself after the machine reboots: plugin
jobs, triggers and cron-armed sessions placed on that host stop until Walnut connects
again. Walnut now makes the daemon a service of the host's own account, with no root
and no step for the user, and Settings > Remote Hosts says on the Daemon row whether
it starts after a reboot, and why not when it does not.

## What starts it, in order

`walnut daemon install --yes` with no `--scope` picks the first of these the account
can have (`src/providers/daemon-service-scope.ts`):

1. **A systemd user service**, when a systemd user manager answers for the account and
   linger is on, or the account may turn linger on itself
   (`loginctl --no-ask-password enable-linger <user>`; polkit's `set-self-linger` allows
   it without a password on some distributions). Walnut never uses sudo for this.
2. **The account's crontab**: one `@reboot` line, tagged `# open-walnut-daemon`, that runs
   the supervisor script `~/.local/share/open-walnut/daemon/daemon-boot.sh`. Used when the
   account may use `crontab` and a cron daemon starts at boot (its systemd unit is enabled,
   or one is running on a system without systemd). The script restarts the daemon on every
   exit (1 s after a clean one, 5 s after a failure, and stops after 5 failures in 60 s),
   reads itself again on each restart (so an update is the new script plus the daemon's own
   update exit), ends when `daemon-boot.stop` is beside it, and never hands its lock to the
   daemon. Every other line of the crontab is kept byte for byte.
3. **Nothing**: the install fails with what each one lacked, and the one step an
   administrator could take (`loginctl enable-linger <user>`, or enabling a cron daemon).

A Mac starts the daemon as a LaunchAgent, which runs when the user logs in.

Either way the service runs the staged daemon binary
(`~/.local/share/open-walnut/daemon/versions/<sha256>/daemon --service`) and keeps its
state (triggers, hooks, plugin jobs, the session registry) in that install root, never in
`/tmp`, which a reboot may empty. Each install or update keeps the version it runs and the
one before it, and removes older ones that no process runs.

## What Walnut does by itself

At each connect to a Linux host (and every 6 hours while connected) the server asks the
host, in one SSH round trip that reads only (`src/providers/remote-boot-start.ts`), which
service config is there and whether it starts at boot. When none is, and the daemon can
hand its sessions to a service (`service-handover-v1`), it runs
`walnut daemon install --yes` on the host with this build's daemon binary (the one already
there on a host that runs the binary, else uploaded in checked chunks). The running daemon
hands its sessions over and exits, the service daemon adopts them, and the connection's
reconnect finds it. A failed attempt is recorded on the host
(`~/.local/share/open-walnut/daemon/boot-setup`): the same build is not tried again for a
day, another build not for six hours. A failure that would leave a service config with no
daemon behind it removes that config, so Walnut runs the daemon the usual way again.

A `walnut daemon uninstall --yes` run on the host is the user's choice: it leaves
`result=removed` in that marker, and Walnut does not set the host up again until someone
installs the service there.

It never replaces a service config that is already there, never sets up the Mac itself or
the cloud box, and never runs from an ephemeral server. It is off with automatic host fixes
(`WALNUT_HOST_AUTOFIX=0`, or `hosts.<name>.autofix: false`; the host is still asked, so
Settings can say so) or with `WALNUT_DAEMON_BOOT_START=0` (nothing is asked at all; the test
setup sets it, so no test reaches a real host this way).

Updates follow the service: a host with a user service or the cron boot script gets each
new daemon build as `walnut daemon update --yes --scope <user|cron>`.

An install or update never stops the old daemon for one that cannot serve. Before any
service change, `walnut daemon install|update` starts the new executable as a daemon in
throwaway directories of its own (`src/providers/daemon-boot-proof.ts`) and refuses, with
nothing changed, when it does not listen within 60 s or does not stay up. After the swap
the new daemon has 60 s to answer, else the previous config is put back. On a Mac every
bootout waits until launchd lets the job go, and a bootstrap asks again for 30 s
(`src/providers/daemon-service-launchd.ts`); every failed install, update or restart of a
service that ran before ends by loading the LaunchAgent or starting the unit again when
nothing runs it, and a cron rollback whose supervisor gave up starts a new one. The server
checks the same after every update it starts (`src/providers/daemon-update-tail.ts`). A new
daemon that served is then watched for 15 minutes (`src/providers/daemon-update-probation.ts`):
one that is gone, or started again twice, gets the config from before back from the copy kept
in the install root (`update-before/`, which a reboot does not clear), and that build is not
run there again for a day. Only an update that changed the service config is watched. A put-back
holds the install lock until the config it put back is loaded, so a later update never finds the
service half restored. No later update starts while the 15 minutes run, a reboot that ended
the watch early included: it is asked again once they are over, so the copy kept for the build
before is never taken by the next update. Copies a reboot left behind are used only while their probation still had
time left, or, with no probation yet (a power loss in the middle of the update), for 7 days unless
a daemon kept serving there for more than an hour after the update.

## Commands on the host

```bash
walnut daemon status                      # the installed service, its startup (boot, login, on-demand)
walnut daemon install --yes --executable <daemon binary>
walnut daemon update --yes --executable <daemon binary>
walnut daemon restart --yes
walnut daemon uninstall --yes             # removes the service; running CLI sessions keep running
```

`--scope user|system|cron` names a backend; a system unit needs `--sudo`.
