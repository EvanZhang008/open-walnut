# Walnut Cloud Companion — Infrastructure

Self-contained CDK app that deploys the always-on EC2 companion for Open Walnut:

```
iPhone / browser ──HTTPS 443──▶ Caddy (auto Let's Encrypt) ──▶ Walnut server (localhost:3456)
Mac (source of truth) ──git smart HTTP over 443──▶ bare hub repo ──post-receive──▶ working tree
```

Data sync setup (Mac-side remote + credentials): see
[cloud sync](../docs/reference/cloud-sync.md).

## One-click setup (recommended)

You do not have to run any of the CDK commands below by hand. Walnut can deploy
this stack, wait for first boot, claim the box, and wire data sync for you:

- **Settings → Cloud Companion** — a wizard that picks a provider, takes a domain
  (or a free auto-address), and shows live progress. It survives a tab reload and
  a server restart.
- **Ask your Personal AI**: "set up my cloud companion". The shipped
  `setup-cloud-companion` skill drives the same resumable job over
  `/api/cloud-setup`, so both surfaces do exactly the same thing.

No domain of your own? Both paths offer an automatic `<dashed-ip>.sslip.io`
address with no DNS record to create.

Either way, the last step is yours: scan the pairing QR under Settings →
Cloud Companion → "Connect your phone".

Everything below is the **advanced / DIY route** — deploying the stack yourself
with the CDK CLI. It stays supported and is the right choice when you want full
control over the deploy, or you are running Walnut somewhere the one-click path
cannot reach a checkout of `infra/`.

- **Ingress: 443 + 80 only.** No SSH, no port 22, no key pair. Port 80 exists solely
  for the Let's Encrypt ACME HTTP-01 challenge (Caddy answers it and redirects the rest).
- **Ops access is SSM Session Manager**: `aws ssm start-session --target <instance-id>`.
- **Data survives**: encrypted gp3 root volume with delete-on-termination disabled,
  plus daily DLM snapshots (retain 7).
- Instance role can invoke Bedrock models (incl. cross-region inference profiles) — the
  offline chat brain needs no stored credentials. Claude Code on the box signs in with
  the same role.

## One-command deploy (manual route)

```bash
cd infra
npm install
npx cdk bootstrap --profile <your-profile>          # first time per account/region only
npx cdk deploy \
  -c domain=wn.example.com \
  -c alertEmail=you@example.com \
  --profile <your-profile>
```

No domain of your own? Swap `-c domain=…` for `-c sslip=1` and the box serves itself at
`<dashed-ip>.sslip.io` with no DNS record to create. Caveat: `sslip.io` is not on the
Public Suffix List, so Let's Encrypt counts every sslip.io user against one shared
rate-limit bucket — `scripts/cloud/setup.sh` therefore turns on Caddy's Let's
Encrypt → ZeroSSL issuer failover for those hostnames.

Account and region come from the profile (`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`).
Nothing personal is hardcoded — this repo is public; keep it that way. `cdk.context.json`
is gitignored on purpose (CDK caches account-specific lookups there).

## Context parameters

| Param | Required | Default | Meaning |
|---|---|---|---|
| `domain` | yes, unless `sslip=1` | — | Public HTTPS hostname, e.g. `wn.example.com`. Caddy obtains the cert for it. |
| `sslip` | no | *(off)* | `1` = no domain of your own: the box serves itself at `<dashed-ip>.sslip.io`, derived from its public IP at boot. Makes `domain` optional; the `Domain` output then reads `sslip-auto` (the real hostname comes from `ElasticIp`). |
| `userDataB64` | no | *(none)* | Base64 first-boot script, supplied by Walnut's one-click cloud setup. When present it fully **replaces** the built-in bootstrap lines. Deploying by hand? Leave it off. |
| `engine` | no | `claude` | Default coding-agent engine for the box (`claude`, `codex`, `gemini`, `opencode`, `goose`, `pi`, `dsh`, `custom`). Its CLI is installed next to Claude Code, which the box always gets. Only reaches the box when set, so an existing stack's user-data (and instance) stays unchanged without it. Ignored when `userDataB64` is given (that script carries its own). |
| `bedrockRegion` | no | `us-west-2` | Region Claude Code on the box calls Bedrock in, through the instance role. Independent of the stack's region. Like `engine`, only passed on when set, and ignored when `userDataB64` is given. |
| `alertEmail` | no | *(none)* | Email subscribed to the alarm SNS topic. Skipped if omitted. |
| `repoUrl` | no | `https://github.com/EvanZhang008/open-walnut.git` | Repo cloned to `/opt/walnut` on first boot. |
| `branch` | no | `main` | Branch to clone. |
| `instanceType` | no | `t4g.small` | ARM (Graviton) instance type. |
| `volumeGb` | no | `30` | Root volume size (gp3, encrypted, retained on termination). |
| `az` | no | `<region>b` | Single AZ for the VPC/subnet. Some accounts lack access to `<region>a` (e.g. this stack defaults to `us-west-1b`). |

## After deploy

1. **DNS**: point an A record for `domain` at the `ElasticIp` output.
   If using Cloudflare, set it to **DNS-only (grey cloud)** — Caddy must receive the
   ACME challenge and terminate TLS itself; the orange-cloud proxy breaks both.
2. Wait a few minutes for first boot: user-data clones the repo and runs
   `scripts/cloud/setup.sh` (installs node/Caddy, builds Walnut, installs Claude Code
   and the default engine's CLI, starts services). Bootstrap log:
   `/var/log/walnut-setup.log` on the instance. What the box installs to run sessions
   itself: [the companion as an exec host](../docs/reference/cloud-sync.md#the-companion-as-an-exec-host).
3. **Shell access** (SSM only):
   ```bash
   aws ssm start-session --target <InstanceId output> --profile <your-profile>
   ```
4. Health: `systemctl status caddy walnut`, `journalctl -u walnut -f`.

## What the stack creates

| Resource | Notes |
|---|---|
| VPC | Dedicated minimal VPC: 1 AZ, 1 public subnet, IGW, **no NAT** ($0). Not `Vpc.fromLookup` — lookups leak the account id into `cdk.context.json`. |
| EC2 instance | `t4g.small` AL2023 arm64 (latest via SSM param), IMDSv2 required, no key pair. |
| EBS root | gp3, encrypted, `DeleteOnTermination: false`. |
| Elastic IP | Stable public IP; output `ElasticIp`. |
| Security group | Inbound `443` + `80` from `0.0.0.0/0` and `::/0`, nothing else. All egress open. |
| Instance role | `AmazonSSMManagedInstanceCore` + inline Bedrock `InvokeModel*` (wildcard region for cross-region inference profiles). |
| DLM policy | Daily snapshot of instance volumes (tag `walnut:backup=daily`), retain 7. |
| SNS + alarm | `StatusCheckFailed >= 1` → topic; email subscription only if `alertEmail` given. |

## Updating the instance later

The instance is cattle-ish: config lives in the repo (`scripts/cloud/setup.sh`), data lives
on the retained volume + git hub. `/opt/walnut` is root's and read-only to the service
user, which runs agents. While that holds, update it over SSM:

```bash
sudo -i
cd /opt/walnut && git pull
bash scripts/cloud/setup.sh <domain>    # safe to re-run
```

A tree the service user could write (a box set up before that rule, for one) is never
taken back and built on in place, and root runs nothing in it, `git pull` included. Move
it aside and clone fresh, or run the deploy, which does that for you. `setup.sh` refuses
such a tree. Steps: [the code tree is root's](../docs/reference/cloud-sync.md#the-companion-as-an-exec-host).

Without `--engine`, a re-run keeps the box's own `defaults.engine`. To converge only
the agent harness (Claude Code, engine CLI, Bedrock settings, cloud exec keys), run
`bash scripts/cloud/ensure-harness.sh`, then `systemctl restart walnut`.
