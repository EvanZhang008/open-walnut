# Walnut Cloud Companion — Infrastructure

Self-contained CDK app that deploys the always-on EC2 companion for Open Walnut:

```
iPhone / browser ──HTTPS 443──▶ Caddy (auto Let's Encrypt) ──▶ Walnut server (localhost:3456)
Mac (source of truth) ──git smart HTTP over 443──▶ bare hub repo ──post-receive──▶ working tree
```

- **Ingress: 443 + 80 only.** No SSH, no port 22, no key pair. Port 80 exists solely
  for the Let's Encrypt ACME HTTP-01 challenge (Caddy answers it and redirects the rest).
- **Ops access is SSM Session Manager**: `aws ssm start-session --target <instance-id>`.
- **Data survives**: encrypted gp3 root volume with delete-on-termination disabled,
  plus daily DLM snapshots (retain 7).
- Instance role can invoke Bedrock models (incl. cross-region inference profiles) — the
  offline chat brain needs no stored credentials.

## One-command deploy

```bash
cd infra
npm install
npx cdk bootstrap --profile <your-profile>          # first time per account/region only
npx cdk deploy \
  -c domain=wn.example.com \
  -c alertEmail=you@example.com \
  --profile <your-profile>
```

Account and region come from the profile (`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`).
Nothing personal is hardcoded — this repo is public; keep it that way. `cdk.context.json`
is gitignored on purpose (CDK caches account-specific lookups there).

## Context parameters

| Param | Required | Default | Meaning |
|---|---|---|---|
| `domain` | **yes** | — | Public HTTPS hostname, e.g. `wn.example.com`. Caddy obtains the cert for it. |
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
   `scripts/cloud/setup.sh` (installs node/Caddy, builds Walnut, starts services).
   Bootstrap log: `/var/log/walnut-setup.log` on the instance.
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
on the retained volume + git hub. To update code, SSM in and:

```bash
sudo -i
cd /opt/walnut && git pull
bash scripts/cloud/setup.sh <domain>    # idempotent — safe to re-run
```
