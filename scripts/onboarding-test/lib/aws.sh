# shellcheck shell=bash
# Target: a brand-new EC2 machine, reached only through SSM Session Manager.
# No SSH keys, no security-group ingress, no public endpoint: the instance sits in
# the default VPC's default security group and only talks OUT to the SSM service.
#
# Everything created carries the tag `walnut-onboarding-test=<run-id>` plus a TTL, so
# `run.sh sweep` can find and kill anything a crashed run left behind. The one IAM
# role is deliberately minimal: AmazonSSMManagedInstanceCore and nothing else.
#
# Two flavours share this file:
#   linux    t3.large (x86) or c7g.large (arm) on Amazon Linux 2023 / Ubuntu 24.04
#   mac-ec2  mac2.metal, which EC2 only sells as a whole physical host with a 24h
#            minimum charge, so the host is reused across runs and released only on
#            request. Accounts need Mac eligibility; without it AllocateHosts fails
#            with UnsupportedHostConfiguration (a support case unlocks it).

AWS_ROLE_NAME="walnut-onboarding-test-ssm"
AWS_HOST_NAME_TAG="walnut-onboarding-test-mac"

awsq() { aws --output text "$@"; }

aws_require() {
  need_cmd aws "brew install awscli"
  need_cmd session-manager-plugin "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
  # Static keys left in the environment silently override --profile; that is the
  # usual reason a working profile suddenly reports an invalid token.
  if [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_PROFILE:-}" ]; then
    warn "AWS_ACCESS_KEY_ID is set alongside AWS_PROFILE=$AWS_PROFILE; unsetting the static keys so the profile wins"
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  fi
  # Identity is only checked, never printed: the ARN carries the account id and the
  # caller's name, and this output ends up in recorded videos.
  local err
  err=$(awsq sts get-caller-identity --query Arn 2>&1 >/dev/null) || die "aws credentials not working: $err"
  ok "aws: credentials OK (profile ${AWS_PROFILE:-default}) in ${AWS_DEFAULT_REGION:-$(aws configure get region)}"
}

aws_ensure_iam_profile() {
  if awsq iam get-instance-profile --instance-profile-name "$AWS_ROLE_NAME" --query InstanceProfile.Arn >/dev/null 2>&1; then
    return 0
  fi
  log "aws: creating minimal IAM role + instance profile $AWS_ROLE_NAME (SSM core only)"
  local trust='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  awsq iam create-role --role-name "$AWS_ROLE_NAME" --assume-role-policy-document "$trust" \
    --tags "Key=$ONB_TAG_KEY,Value=iam" --query Role.Arn >/dev/null 2>&1 || true
  awsq iam attach-role-policy --role-name "$AWS_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  awsq iam create-instance-profile --instance-profile-name "$AWS_ROLE_NAME" --query InstanceProfile.Arn >/dev/null 2>&1 || true
  awsq iam add-role-to-instance-profile --instance-profile-name "$AWS_ROLE_NAME" --role-name "$AWS_ROLE_NAME" 2>/dev/null || true
  log "aws: waiting for IAM propagation"; sleep 12
}

aws_default_subnet() {  # $1 = AZ (optional)
  local vpc
  vpc=$(awsq ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId')
  [ -n "$vpc" ] && [ "$vpc" != None ] || die "aws: no default VPC in this region; set WALNUT_ONB_SUBNET"
  if [ -n "${1:-}" ]; then
    awsq ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" "Name=availability-zone,Values=$1" --query 'Subnets[0].SubnetId'
  else
    awsq ec2 describe-subnets --filters "Name=vpc-id,Values=$vpc" "Name=default-for-az,Values=true" --query 'Subnets[0].SubnetId'
  fi
}

aws_ami() {  # $1 = os key → AMI id via the public SSM parameters (always the current image)
  local p
  case "$1" in
    al2)     p=/aws/service/ami-amazon-linux-latest/amzn2-ami-kernel-5.10-hvm-x86_64-gp2 ;;  # glibc 2.26: the old-C-library case
    al2023)  p=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 ;;
    al2023-arm) p=/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 ;;
    ubuntu)  p=/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id ;;
    sequoia) p=/aws/service/ec2-macos/sequoia/arm64_mac/latest/image_id ;;
    tahoe)   p=/aws/service/ec2-macos/tahoe/arm64_mac/latest/image_id ;;
    *) die "unknown --os $1 (al2 | al2023 | al2023-arm | ubuntu | sequoia | tahoe)" ;;
  esac
  awsq ssm get-parameter --name "$p" --query Parameter.Value
}

# aws_launch <ami> <type> <run-id> <ttl-epoch> <login-user> [host-id]  → INSTANCE_ID
aws_launch() {
  local ami="$1" itype="$2" run_id="$3" ttl="$4" user="$5" host="${6:-}" subnet placement=""
  aws_ensure_iam_profile
  if [ -n "$host" ]; then
    local az; az=$(awsq ec2 describe-hosts --host-ids "$host" --query 'Hosts[0].AvailabilityZone')
    subnet=$(aws_default_subnet "$az"); placement="--placement HostId=$host,Tenancy=host"
  else
    subnet="${WALNUT_ONB_SUBNET:-$(aws_default_subnet)}"
  fi
  log "aws: launching $itype from $ami (login user: $user)"
  # shellcheck disable=SC2086
  INSTANCE_ID=$(awsq ec2 run-instances --image-id "$ami" --instance-type "$itype" --subnet-id "$subnet" \
    --iam-instance-profile "Name=$AWS_ROLE_NAME" $placement \
    --instance-initiated-shutdown-behavior terminate \
    --block-device-mappings "[{\"DeviceName\":\"$(awsq ec2 describe-images --image-ids "$ami" --query 'Images[0].RootDeviceName')\",\"Ebs\":{\"VolumeSize\":${WALNUT_ONB_DISK_GB:-60},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --metadata-options HttpTokens=required \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$run_id},{Key=$ONB_TAG_KEY,Value=$run_id},{Key=$ONB_TTL_TAG_KEY,Value=$ttl}]" \
      "ResourceType=volume,Tags=[{Key=$ONB_TAG_KEY,Value=$run_id}]" \
    --query 'Instances[0].InstanceId') || die "aws: run-instances failed"
  case "$INSTANCE_ID" in i-*) ;; *) die "aws: run-instances returned no instance id: '$INSTANCE_ID'" ;; esac
  on_exit_push "aws_terminate '$INSTANCE_ID'"
  ok "aws: $INSTANCE_ID launched"
}

aws_terminate() {
  [ -n "${1:-}" ] || return 0
  [ "${KEEP:-0}" = 1 ] && { warn "aws: --keep set, leaving $1 running (sweep later: run.sh sweep)"; return 0; }
  log "aws: terminating $1"
  awsq ec2 terminate-instances --instance-ids "$1" --query 'TerminatingInstances[0].CurrentState.Name' >/dev/null 2>&1 || true
}

# Wait for the SSM agent to register (Linux ~1-2 min; macOS 5-15 min).
aws_wait_ssm() {
  local iid="$1" timeout="${2:-600}"
  log "aws: waiting for SSM agent on $iid (up to ${timeout}s)"
  wait_for "[ \"\$(awsq ssm describe-instance-information --filters Key=InstanceIds,Values=$iid --query 'InstanceInformationList[0].PingStatus')\" = Online ]" "$timeout" 10 \
    || die "aws: SSM agent never came online on $iid"
  ok "aws: SSM online"
}

# aws_ssm_put_file <iid> <local> <remote-path>   (small files: base64 in one command)
aws_ssm_put_file() {
  local iid="$1" b64 cid
  b64=$(base64 < "$2" | tr -d '\n')
  cid=$(awsq ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
    --parameters "{\"commands\":[\"printf '%s' '$b64' | base64 -d > '$3' && chmod 755 '$3'\"]}" --query Command.CommandId)
  wait_for "[ \"\$(awsq ssm get-command-invocation --command-id $cid --instance-id $iid --query Status 2>/dev/null)\" = Success ]" 60 2 \
    || die "aws: could not place $3 on $iid"
}

# aws_ssm_cat <iid> <remote-path> > stdout   (≤24KB; callers tail large logs first)
aws_ssm_cat() {
  local iid="$1" cid
  cid=$(awsq ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
    --parameters "{\"commands\":[\"cat '$2' 2>/dev/null || true\"]}" --query Command.CommandId)
  wait_for "[ \"\$(awsq ssm get-command-invocation --command-id $cid --instance-id $iid --query Status 2>/dev/null)\" = Success ]" 60 2 || return 1
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" --query StandardOutputContent --output text
}

# aws_ssm_exec <iid> <shell-command> [timeout-s]  — run to completion, print stdout+stderr.
aws_ssm_exec() {
  local iid="$1" cmd="$2" timeout="${3:-120}" cid
  cid=$(aws ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript --timeout-seconds "$timeout" \
    --parameters "$(node -e 'process.stdout.write(JSON.stringify({commands:[process.argv[1]]}))' "$cmd")" \
    --query Command.CommandId --output text) || return 1
  wait_for "case \"\$(awsq ssm get-command-invocation --command-id $cid --instance-id $iid --query Status 2>/dev/null)\" in Success|Failed|TimedOut|Cancelled) true;; *) false;; esac" "$((timeout + 30))" 2 || return 1
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" --query '[StandardOutputContent,StandardErrorContent]' --output text
}

# aws_ssm_follow <iid> <shell-command> <remote-out-file>
# Streaming a long command through Session Manager needs a TTY, so instead the command
# runs detached on the instance writing to a file, and this side polls the file for new
# bytes every few seconds. Near-live, and it needs nothing but send-command.
aws_ssm_follow() {
  local iid="$1" cmd="$2" out="$3" offset=0 chunk size state
  aws_ssm_exec "$iid" "mkdir -p \"\$(dirname $out)\"; rm -f $out.exit; nohup bash -c $(printf '%q' "$cmd; echo \$? > $out.exit") > $out 2>&1 < /dev/null & disown" 30 >/dev/null \
    || die "aws: could not start the remote command"
  while :; do
    # one round trip: the new bytes since offset, then a marker line with size + done flag
    chunk=$(aws_ssm_exec "$iid" "tail -c +$((offset + 1)) $out 2>/dev/null | head -c 20000; printf '\n@@%s %s@@' \"\$(wc -c < $out 2>/dev/null | tr -d ' ')\" \"\$([ -f $out.exit ] && cat $out.exit || echo running)\"" 60) || { warn "aws: poll failed, retrying"; sleep 5; continue; }
    size=$(printf '%s' "$chunk" | sed -n 's/.*@@\([0-9]*\) \([a-z0-9]*\)@@.*/\1/p' | tail -1)
    state=$(printf '%s' "$chunk" | sed -n 's/.*@@\([0-9]*\) \([a-z0-9]*\)@@.*/\2/p' | tail -1)
    printf '%s' "$chunk" | sed '$d' | sed 's/^None$//'   # drop the marker line (and the empty stderr "None")
    [ -n "$size" ] && offset=$size
    case "$state" in running|'') sleep 4 ;; *) echo; return 0 ;; esac
  done
}

# aws_port_forward <iid> <remote-port> <local-port>
aws_port_forward() {
  aws ssm start-session --target "$1" --document-name AWS-StartPortForwardingSession \
    --parameters "{\"portNumber\":[\"$2\"],\"localPortNumber\":[\"$3\"]}" > "$RUN_DIR/port-forward-$3.log" 2>&1 &
  FWD_PID=$!
  on_exit_push "kill $FWD_PID 2>/dev/null || true"
  wait_for "curl -s -o /dev/null http://127.0.0.1:$3/api/system/health" 45 1 || warn "aws: port-forward $2→$3 not answering (see $RUN_DIR/port-forward-$3.log)"
}

# ── Mac host (whole physical machine, 24h minimum charge) ─────────────────────
# aws_mac_host <instance-type>  → sets HOST_ID (reusing an available tagged host) or dies.
# Sets a variable rather than printing so the cost refusal below can actually stop the
# run: a `die` inside $(...) only exits the subshell.
aws_mac_host() {
  local itype="$1" hid az
  hid=$(awsq ec2 describe-hosts --filters "Name=tag:Name,Values=$AWS_HOST_NAME_TAG" "Name=instance-type,Values=$itype" "Name=state,Values=available" --query 'Hosts[0].HostId')
  if [ -n "$hid" ] && [ "$hid" != None ]; then log "aws: reusing Mac host $hid (inside its 24h window)"; HOST_ID="$hid"; return 0; fi
  [ "${YES_MAC_HOST:-0}" = 1 ] || die "a $itype host bills a 24h minimum (~USD 16-32). Re-run with --yes-mac-host to allocate one."
  az="${WALNUT_ONB_AZ:-${AWS_DEFAULT_REGION:-$(aws configure get region)}a}"
  log "aws: allocating $itype host in $az (24h minimum charge starts now)"
  hid=$(awsq ec2 allocate-hosts --instance-type "$itype" --availability-zone "$az" --quantity 1 \
    --tag-specifications "ResourceType=dedicated-host,Tags=[{Key=Name,Value=$AWS_HOST_NAME_TAG},{Key=$ONB_TAG_KEY,Value=host}]" \
    --query 'HostIds[0]' 2>&1) || die "aws: allocate-hosts failed: $hid  (UnsupportedHostConfiguration = this account is not yet eligible for Mac hosts; open a support case)"
  [ -n "$hid" ] && [ "$hid" != None ] || die "aws: allocate-hosts returned no host id"
  HOST_ID="$hid"
}

aws_release_hosts() {
  local ids
  ids=$(awsq ec2 describe-hosts --filters "Name=tag:Name,Values=$AWS_HOST_NAME_TAG" "Name=state,Values=available" --query 'Hosts[?length(Instances)==`0`].HostId' | tr '\t' ' ')
  [ -n "$ids" ] || { log "aws: no idle Mac hosts to release"; return 0; }
  # shellcheck disable=SC2086
  awsq ec2 release-hosts --host-ids $ids --query 'Successful' && ok "aws: released $ids"
}

# ── sweep: kill anything past its TTL that carries our tag ────────────────────
aws_sweep() {
  local now ids
  now=$(now_s)
  ids=$(awsq ec2 describe-instances --filters "Name=tag-key,Values=$ONB_TAG_KEY" Name=instance-state-name,Values=pending,running,stopping,stopped \
        --query "Reservations[].Instances[].[InstanceId,Tags[?Key=='$ONB_TTL_TAG_KEY'].Value|[0]]" | \
        awk -v now="$now" -v force="${SWEEP_ALL:-0}" '$2=="" || $2=="None" || $2+0 < now || force==1 {print $1}')
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    awsq ec2 terminate-instances --instance-ids $ids --query 'TerminatingInstances[].InstanceId' && ok "sweep: terminated $ids"
  else
    log "sweep: no expired instances"
  fi
  [ "${RELEASE_HOSTS:-0}" = 1 ] && aws_release_hosts
  return 0
}

aws_status() {
  echo "instances tagged $ONB_TAG_KEY:"
  aws ec2 describe-instances --filters "Name=tag-key,Values=$ONB_TAG_KEY" \
    --query "Reservations[].Instances[].{id:InstanceId,type:InstanceType,state:State.Name,name:Tags[?Key=='Name'].Value|[0],ttl:Tags[?Key=='$ONB_TTL_TAG_KEY'].Value|[0]}" --output table
  echo "Mac hosts:"
  aws ec2 describe-hosts --filters "Name=tag:Name,Values=$AWS_HOST_NAME_TAG" --query 'Hosts[].{id:HostId,type:InstanceType,state:State,az:AvailabilityZone,since:AllocationTime,instances:length(Instances)}' --output table
}
