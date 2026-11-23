# Kubernetes hosts

A Walnut host can be a pod in a Kubernetes cluster: sessions, `host_exec`, files and the
terminal work there as on any other machine. Nothing new runs on the Mac and nothing opens on
the cluster's network: the pod joins the user's host network with one invite
(`docs/reference/host-network.md`), and from then on the Mac reaches its daemon over that
encrypted link, through the relay when the two cannot see each other. The files are in
`infra/kubernetes/`: an image (`Dockerfile`, `entrypoint.sh`) and the objects to apply
(`walnut-host.yaml`).

## What a pod keeps, and where

The pod's home (`/home/walnut`) is a persistent volume. Everything a host must keep is there,
so the pod itself holds nothing that matters:

| What | Where | Why it must stay |
|---|---|---|
| Claude Code's history | `~/.claude/projects/<dir>/<session>.jsonl` and its sidecar folder | the conversation; `--resume` reads it, and Walnut's own copies on the Mac are caches rebuilt from it |
| The host's network key | `~/.local/state/open-walnut/net/` | the host's identity: the same key is the same host on the Mac, so no new invite |
| Walnut, its daemon and host server | `~/.local/share/open-walnut/`, `~/.open-walnut-host/` | the Mac updates them over the link; a new pod runs what the volume holds |
| Claude Code itself (installed by Install, below), other tools a session installed | `~/.local/` | a session's setup is not lost with the pod |
| The daemon's crontab | `~/.walnut-pod/crontabs/` (cron's spool directory is a link to it) | the `@reboot` line that starts the daemon (below) |
| Task directories, checkouts | `~/.local/state/open-walnut/tasks/`, anywhere under `~` | work in progress |
| The daemon's live files | `/tmp/open-walnut*` (an `emptyDir`) | not kept: they outlive a container restart (as after a crash) and are gone with the pod (as at a reboot) |

What survives what:

| Event | Sessions running then | History, identity, installs |
|---|---|---|
| The container restarts (a crash, an out-of-memory kill) | end; the next message resumes them | kept |
| The pod is deleted, its node is replaced or expires, a new image rolls out | end; the next message resumes them | kept: the new pod mounts the same volume |
| The StatefulSet is deleted | end | kept: the claim and the disk are retained (`whenDeleted: Retain`, `reclaimPolicy: Retain`) |
| The volume is deleted | end | gone: that is how a host is removed |

A session that a restart ended is like one on a machine that rebooted: its transcript is on
the volume, so Walnut starts its CLI again with `--resume` and the conversation goes on with
its whole history.

## How the daemon stays up

`walnut daemon install` keeps the daemon running with a systemd user unit, else with a cron
`@reboot` line (`src/providers/daemon-service-cron.ts`). A container has no systemd, so the
image runs Debian's cron as the container's main process (under tini, as root, which cron
needs to run a user's jobs) and everything else runs as the user `walnut`. The entrypoint:

1. gives a new volume to the user and puts the shell's start files in it;
2. links cron's spool directory to the volume, so the daemon's `@reboot` line is there on
   every start;
3. starts cron, which runs that line: the daemon comes back with everything the volume holds;
4. on a home that never joined, joins once with the invite in `/etc/walnut-join/invite`
   (the secret `walnut-join`, optional): the join script installs Walnut, `walnut daemon
   install` picks the cron backend, and the host appears in Settings > Remote Hosts;
5. runs the user's own start scripts, `~/.config/walnut-pod/boot.d/*` (executable files),
   as the user, their output in `~/.local/state/walnut-pod/boot.log`;
6. waits on cron: cron ending ends the container, and Kubernetes starts it again.

A stop (the pod deleted, its node drained or replaced) is a shutdown, as on a machine: every
process in the container gets TERM, and the user's processes get 45 seconds to end
(`WALNUT_POD_STOP_SECONDS`, within the pod's 60-second grace period), so a running session
writes its last turn and ends cleanly. The steps that run as root never follow a link in the
home and keep only the directories root made itself: anything else in their place is moved
aside (`~/.walnut-pod.moved-<time>`).

The Mac keeps the daemon on its own build over the link, as for any joined machine whose
daemon is a cron service (`src/providers/daemon-net-update.ts`).

## Setting one up

1. Build the image and push it where the cluster pulls from:
   `docker build -t <registry>/walnut-host:<tag> infra/kubernetes && docker push <registry>/walnut-host:<tag>`,
   and set it as the StatefulSet's `image`.
2. Settings > Remote Hosts > Add a machine, and copy the link (or, with no companion, the
   `wn1-` ticket). It is one use and lasts 10 minutes.
3. Within those 10 minutes:

       kubectl create namespace walnut
       kubectl -n walnut create secret generic walnut-join --from-literal=invite='<link or ticket>'
       kubectl apply -f infra/kubernetes/walnut-host.yaml

4. The pod is `eks-walnut-0` and joins with that name. `kubectl -n walnut logs eks-walnut-0`
   shows the join's three steps.
5. Claude Code is not in the image: as on any joined machine, click Install on the host's
   Claude Code line in Settings > Remote Hosts (it runs Claude Code's own installer into
   `~/.local`, on the volume), or run that installer in the host's terminal.

`walnut-host.yaml` is written for EKS Auto Mode: its StorageClass uses Auto Mode's EBS
provisioner (`ebs.csi.eks.amazonaws.com`; with the EBS CSI add-on it is `ebs.csi.aws.com`),
and its NodePool (on Auto Mode's own NodeClass, `default`) gives the pods nodes of their own, tainted for them and consolidated only
when empty, while the pod's `karpenter.sh/do-not-disrupt` keeps consolidation and drift from
moving a pod with running sessions. On another cluster, change the provisioner and leave out
the NodePool with the pod's `nodeSelector` and toleration.

The pod gets no service account token (`automountServiceAccountToken: false`), so a session
cannot use the cluster's API. On EKS Auto Mode a pod could not reach the node's instance
metadata either (seen from such a pod: IMDSv1 answers 401 and the IMDSv2 token request times
out, as a hop limit of 1 does), so it cannot take the node's role. On another cluster, check
this before giving a host to anyone: set the hop limit to 1 or block the address.

## Models

A session's model calls go wherever that host's Claude Code is set up to send them. The pod
has no credentials of its own: set up the model proxy there as on any joined machine (the
Model proxy plugin makes a new machine a spoke of the Mac's hub, through a hub forward,
`docs/reference/host-network.md`), or give the pod credentials of its own in its home. A
program the pod must keep running that has no service manager there (a model proxy started
with its own `start` command) gets a line in the user's crontab, as the daemon has: cron is the
pod's service manager, so `* * * * * <program's own start-if-not-running command>` brings it
back after a restart or a crash. A one-off at each start goes in
`~/.config/walnut-pod/boot.d/` instead.

## Limits

- One invite joins one pod. For more hosts, scale the StatefulSet one replica at a time and
  give each new pod its own invite before it starts (the secret is read only by a home that
  never joined).
- An EBS volume lives in one availability zone, so the pod always comes back in that zone.
- A node's lifetime is capped (Auto Mode replaces nodes after at most 21 days): the pod then
  restarts on a new node. Sessions running then end and resume on their next message, as
  above.
- The container runs cron as root; Walnut and its sessions run as `walnut`, without sudo.
- No Docker daemon in the pod; nothing that needs a Mac (iOS, WebKit on macOS) runs there.

## Removing one

Settings > Remote Hosts > the host > Remove, then `kubectl -n walnut delete statefulset
eks-walnut`, then the claim `home-eks-walnut-0` and, since the disk is retained, its volume:
deleting the volume deletes the host's history for good.
