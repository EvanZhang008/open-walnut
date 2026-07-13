/**
 * WalnutCloudStack — single-stack EC2 deployment for the Walnut cloud companion.
 *
 * Architecture: iPhone/browser → HTTPS 443 → Caddy (auto Let's Encrypt) →
 * Walnut server (localhost:3456). Mac↔EC2 data sync is git smart HTTP over
 * the same 443 (no SSH — the security group allows only 443 + 80 inbound).
 * Ops access is SSM Session Manager only (no key pair, no port 22).
 *
 * Everything personal (domain, alert email, repo) flows in via CDK context
 * (`-c key=value`) — nothing account- or user-specific is hardcoded here.
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as dlm from 'aws-cdk-lib/aws-dlm'

const DEFAULT_REPO_URL = 'https://github.com/EvanZhang008/open-walnut.git'

export class WalnutCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ── Context parameters ──────────────────────────────────────────────
    const domain = this.node.tryGetContext('domain') as string | undefined
    if (!domain) {
      throw new Error(
        'Missing required context "domain" — the public HTTPS hostname for this instance.\n'
        + 'Pass it with: cdk deploy -c domain=wn.example.com',
      )
    }
    const repoUrl = (this.node.tryGetContext('repoUrl') as string | undefined) ?? DEFAULT_REPO_URL
    const branch = (this.node.tryGetContext('branch') as string | undefined) ?? 'main'
    const alertEmail = this.node.tryGetContext('alertEmail') as string | undefined
    const instanceType = (this.node.tryGetContext('instanceType') as string | undefined) ?? 't4g.small'
    const volumeGb = Number(this.node.tryGetContext('volumeGb') ?? 30)
    // Single AZ for the whole stack. Default <region>b because some accounts
    // (e.g. this one in us-west-1) only have access to the b/c AZs. Override
    // with -c az=us-west-1c if needed.
    const az = (this.node.tryGetContext('az') as string | undefined) ?? `${this.region}b`

    // ── Networking: dedicated minimal VPC ───────────────────────────────
    // Deliberately NOT Vpc.fromLookup — a lookup caches the account id into
    // cdk.context.json, which must never land in this public repo. A fresh
    // 1-AZ public-subnet VPC with an IGW and no NAT gateway costs $0.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.42.0.0/24'),
      availabilityZones: [az],
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          // Auto-assign a public IP at launch so user-data has internet
          // access immediately — the EIP association happens later in the
          // same deployment and would otherwise leave first boot offline.
          mapPublicIpOnLaunch: true,
        },
      ],
      natGateways: 0,
    })

    // ── Security group: 443 + 80 only ───────────────────────────────────
    const sg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'Walnut cloud companion: HTTPS (443) + ACME HTTP-01 (80) only',
      allowAllOutbound: true,
      allowAllIpv6Outbound: true,
    })
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from anywhere (IPv4)')
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'HTTPS from anywhere (IPv6)')
    // Port 80 is required for the Let's Encrypt ACME HTTP-01 challenge —
    // Caddy answers it to obtain/renew the certificate and redirects
    // everything else to HTTPS. Do not remove.
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'ACME HTTP-01 + HTTPS redirect (IPv4)')
    sg.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'ACME HTTP-01 + HTTPS redirect (IPv6)')

    // ── IAM instance role ───────────────────────────────────────────────
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Walnut cloud companion instance role: SSM + Bedrock invoke',
      managedPolicies: [
        // Session Manager is the ONLY ops access path (no SSH).
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    })
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      // Region is wildcarded on purpose: cross-region inference profiles
      // route requests through other regions' foundation models.
      resources: [
        'arn:aws:bedrock:*::foundation-model/*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }))
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'WalnutSecrets',
      // Runtime secrets (e.g. the OpenAI key for the voice STT fallback) live
      // under /walnut/* as SecureStrings; setup.sh materializes them into
      // /etc/walnut/walnut.env on boot. Read-only, path-scoped.
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/walnut/*`],
    }))

    // ── User data: minimal bootstrap, real logic lives in the repo ──────
    const userData = ec2.UserData.forLinux()
    userData.addCommands(
      'set -o pipefail',
      'dnf install -y git',
      `git clone --branch ${branch} ${repoUrl} /opt/walnut`,
      `bash /opt/walnut/scripts/cloud/setup.sh ${domain} 2>&1 | tee /var/log/walnut-setup.log`,
    )

    // ── EC2 instance ────────────────────────────────────────────────────
    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(instanceType),
      // Latest AL2023 arm64 AMI resolved through the public SSM parameter at
      // deploy time — no AMI id or account-specific lookup is baked in.
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: sg,
      role,
      userData,
      requireImdsv2: true,
      detailedMonitoring: false,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(volumeGb, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            // Data survives instance replacement — the volume is retained
            // and can be re-attached / snapshot-restored.
            deleteOnTermination: false,
          }),
        },
      ],
    })

    // Tag targeted by the DLM lifecycle policy below.
    cdk.Tags.of(instance).add('walnut:backup', 'daily')

    // ── Elastic IP ──────────────────────────────────────────────────────
    const eip = new ec2.CfnEIP(this, 'Eip', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: 'walnut-cloud' }],
    })
    new ec2.CfnEIPAssociation(this, 'EipAssociation', {
      allocationId: eip.attrAllocationId,
      instanceId: instance.instanceId,
    })

    // ── DLM: daily snapshots of the instance's volumes, retain 7 ────────
    const dlmRole = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSDataLifecycleManagerServiceRole',
        ),
      ],
    })
    new dlm.CfnLifecyclePolicy(this, 'DailySnapshots', {
      // DLM descriptions only allow [0-9A-Za-z _-]
      description: 'Walnut cloud companion daily volume snapshots retain 7',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['INSTANCE'],
        targetTags: [{ key: 'walnut:backup', value: 'daily' }],
        schedules: [
          {
            name: 'daily-7',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['09:00'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    })

    // ── Monitoring: status-check alarm → SNS ────────────────────────────
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      displayName: 'Walnut cloud companion alerts',
    })
    if (alertEmail) {
      alertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail))
    }
    const statusAlarm = new cloudwatch.Alarm(this, 'StatusCheckAlarm', {
      alarmDescription: `Walnut cloud instance failing EC2 status checks (${domain})`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed',
        dimensionsMap: { InstanceId: instance.instanceId },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    })
    statusAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic))

    // ── Outputs ─────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.instanceId,
      description: 'EC2 instance id (use with: aws ssm start-session --target <id>)',
    })
    new cdk.CfnOutput(this, 'ElasticIp', {
      value: eip.attrPublicIp,
      description: `Point the DNS A record for ${domain} at this IP (DNS-only / grey cloud)`,
    })
    new cdk.CfnOutput(this, 'Domain', { value: domain })
  }
}
