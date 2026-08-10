/**
 * Synth-level tests for WalnutCloudStack.
 *
 * These assert the two context knobs Walnut's one-click provisioner depends on
 * (`userDataB64`, `sslip`) without touching AWS: Template.fromStack runs the
 * same synthesis `cdk deploy` does, offline. A fake account/region is supplied
 * because the stack pins an AZ off `this.region` — the stack deliberately avoids
 * Vpc.fromLookup, so nothing here makes an API call.
 */
import { describe, it, expect } from 'vitest'
import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { WalnutCloudStack } from '../lib/walnut-cloud-stack'

const ENV = { account: '111111111111', region: 'us-east-1' }

/** Synth the stack with the given context and return its template. */
function synth(context: Record<string, string>): Template {
  const app = new cdk.App({ context })
  const stack = new WalnutCloudStack(app, 'WalnutCloudStack', { env: ENV })
  return Template.fromStack(stack)
}

/**
 * The instance's user-data as a plain string. CloudFormation stores it as
 * `{ 'Fn::Base64': <script> }`, where the script is either a literal or an
 * Fn::Join of literals and refs (the provisioner path embeds the Elastic IP's
 * token). Refs are flattened to `<Ref:LogicalId>` so a test can assert which
 * resource a line points at without depending on CDK's join granularity.
 */
function userDataScript(template: Template): string {
  const instances = template.findResources('AWS::EC2::Instance')
  const keys = Object.keys(instances)
  expect(keys).toHaveLength(1)
  const raw = instances[keys[0]].Properties.UserData['Fn::Base64']
  if (typeof raw === 'string') return raw
  const parts = raw['Fn::Join'][1] as Array<unknown>
  return parts
    .map((p) => (typeof p === 'string' ? p : `<Ref:${(p as { Ref: string }).Ref}>`))
    .join('')
}

/** Value of a named CfnOutput. */
function outputValue(template: Template, name: string): unknown {
  const outputs = template.findOutputs(name)
  expect(Object.keys(outputs), `output ${name} should exist`).toContain(name)
  return outputs[name].Value
}

describe('context validation', () => {
  it('throws when neither domain nor sslip is given', () => {
    expect(() => synth({})).toThrow(/Missing required context "domain"/)
  })

  it('the throw names both ways out (own domain, or sslip)', () => {
    expect(() => synth({})).toThrow(/sslip=1/)
  })

  it('treats any sslip value other than "1" as absent', () => {
    expect(() => synth({ sslip: 'true' })).toThrow(/Missing required context "domain"/)
  })
})

describe('user-data', () => {
  it('without userDataB64: keeps the default clone-and-run lines verbatim', () => {
    const script = userDataScript(synth({ domain: 'wn.example.com' }))
    expect(script).toContain('dnf install -y git')
    expect(script).toContain(
      'git clone --branch main https://github.com/EvanZhang008/open-walnut.git /opt/walnut',
    )
    expect(script).toContain('DOMAIN=wn.example.com')
    expect(script).toContain(
      'bash /opt/walnut/scripts/cloud/setup.sh "$DOMAIN" 2>&1 | tee /var/log/walnut-setup.log',
    )
    // No metadata lookup when the hostname is known up front.
    expect(script).not.toContain('169.254.169.254')
    // The provisioner-only decode path must not appear on the manual path.
    expect(script).not.toContain('base64 -d')
  })

  it('sslip without userDataB64: derives the host via IMDSv2 (a token request, never v1)', () => {
    // requireImdsv2 is set on the instance, so a tokenless metadata read would
    // 401 and leave $DOMAIN empty — the token PUT is load-bearing, not stylistic.
    const script = userDataScript(synth({ sslip: '1' }))
    expect(script).toContain('-X PUT http://169.254.169.254/latest/api/token')
    expect(script).toContain('X-aws-ec2-metadata-token-ttl-seconds: 300')
    expect(script).toContain('-H "X-aws-ec2-metadata-token: $TOKEN"')
    expect(script).toContain('http://169.254.169.254/latest/meta-data/public-ipv4')
    expect(script).toContain('DOMAIN="$(echo "$IP" | tr . -).sslip.io"')
    // The public-ipv4 read must NOT appear without the token header attached.
    expect(script).not.toMatch(/curl(?![^\n]*metadata-token)[^\n]*public-ipv4/)
  })

  it('honours repoUrl/branch on the default path', () => {
    const script = userDataScript(synth({
      domain: 'wn.example.com',
      repoUrl: 'https://github.com/acme/fork.git',
      branch: 'release/1.x',
    }))
    expect(script).toContain('git clone --branch release/1.x https://github.com/acme/fork.git /opt/walnut')
  })

  it('with userDataB64: decodes the supplied script and runs it instead', () => {
    const b64 = Buffer.from('#!/usr/bin/env bash\necho hi\n', 'utf-8').toString('base64')
    const script = userDataScript(synth({ domain: 'wn.example.com', userDataB64: b64 }))
    expect(script).toContain(`echo ${b64} | base64 -d > /run/walnut-bootstrap.sh`)
    expect(script).toContain('bash /run/walnut-bootstrap.sh')
    // The default lines must be fully REPLACED, not appended to — otherwise the
    // box would clone and run setup.sh twice.
    expect(script).not.toContain('dnf install -y git')
    expect(script).not.toContain('/opt/walnut/scripts/cloud/setup.sh')
  })

  it('with userDataB64: hands the boot script the Elastic IP, not a metadata read', () => {
    // The subnet auto-assigns a public address at launch and the EIP associates
    // mid-boot, so an on-box metadata read yields an address that stops being
    // ours — two agreeing reads of it prove nothing. The export is the only
    // thing that makes the derived sslip.io hostname match what the operator's
    // Walnut polls.
    const b64 = Buffer.from('#!/usr/bin/env bash\necho boot\n', 'utf-8').toString('base64')
    const script = userDataScript(synth({ sslip: '1', userDataB64: b64 }))
    expect(script).toMatch(/export WALNUT_PUBLIC_IP=<Ref:Eip>/)
    // The export must precede the script it is meant to configure.
    expect(script.indexOf('WALNUT_PUBLIC_IP')).toBeLessThan(script.indexOf('base64 -d'))
  })

  it('does not leak the decoded boot script into the template (only the base64)', () => {
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    const b64 = Buffer.from(`printf '%s' '${secret}' > /etc/walnut/setup-token\n`, 'utf-8').toString('base64')
    const template = JSON.stringify(synth({ domain: 'wn.example.com', userDataB64: b64 }).toJSON())
    expect(template).toContain(b64)
    // Plaintext of the pairing code must never appear as its own string.
    expect(template).not.toContain(secret)
  })
})

describe('sslip mode', () => {
  const b64 = Buffer.from('#!/usr/bin/env bash\necho boot\n', 'utf-8').toString('base64')

  it('synths with no domain at all', () => {
    expect(() => synth({ sslip: '1', userDataB64: b64 })).not.toThrow()
  })

  it("outputs Domain 'sslip-auto' (informational — the real host is derived from the IP)", () => {
    expect(outputValue(synth({ sslip: '1', userDataB64: b64 }), 'Domain')).toBe('sslip-auto')
  })

  it('still outputs the Elastic IP, which is what the hostname is derived from', () => {
    const template = synth({ sslip: '1', userDataB64: b64 })
    template.resourceCountIs('AWS::EC2::EIP', 1)
    template.resourceCountIs('AWS::EC2::EIPAssociation', 1)
    expect(outputValue(template, 'ElasticIp')).toBeDefined()
  })

  it('own-domain mode outputs the domain itself', () => {
    expect(outputValue(synth({ domain: 'wn.example.com' }), 'Domain')).toBe('wn.example.com')
  })

  it('leaves the security group, role and instance identical to own-domain mode', () => {
    const sslipT = synth({ sslip: '1', userDataB64: b64 })
    const domainT = synth({ domain: 'wn.example.com', userDataB64: b64 })
    for (const t of [sslipT, domainT]) {
      t.resourceCountIs('AWS::EC2::SecurityGroup', 1)
      t.resourceCountIs('AWS::EC2::Instance', 1)
      t.resourceCountIs('AWS::DLM::LifecyclePolicy', 1)
      // Exactly four rules: 443 + 80, over IPv4 and IPv6, and nothing else
      // (no port 22 — SSM is the only ops path). Compared as a set so the
      // assertion tracks intent rather than CDK's emission order.
      const sg = Object.values(t.findResources('AWS::EC2::SecurityGroup'))[0]
      const ingress = (sg.Properties.SecurityGroupIngress as Array<Record<string, unknown>>)
        .map((r) => `${r.IpProtocol}:${r.FromPort}:${r.CidrIp ?? r.CidrIpv6}`)
        .sort()
      expect(ingress).toEqual([
        'tcp:443:0.0.0.0/0',
        'tcp:443:::/0',
        'tcp:80:0.0.0.0/0',
        'tcp:80:::/0',
      ])
    }
    // IMDSv2 is required, which is why the boot script must use a token request.
    sslipT.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    })
  })

  it('does not subscribe an email to the alarm topic unless alertEmail is given', () => {
    synth({ sslip: '1', userDataB64: b64 }).resourceCountIs('AWS::SNS::Subscription', 0)
    synth({ sslip: '1', userDataB64: b64, alertEmail: 'you@example.com' })
      .resourceCountIs('AWS::SNS::Subscription', 1)
  })
})
