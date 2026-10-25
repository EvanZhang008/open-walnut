#!/usr/bin/env node
/**
 * CDK app entry point for the Open Walnut cloud companion stack.
 *
 * Account/region come from `-c account` / `-c region` when given, else from the
 * active AWS profile (CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION), so nothing
 * personal is hardcoded here. All deployment parameters flow in via
 * `-c key=value` context (see infra/README.md).
 */
import * as cdk from 'aws-cdk-lib'
import { WalnutCloudStack } from '../lib/walnut-cloud-stack'

const app = new cdk.App()

// `-c account` / `-c region` win when given: Walnut's setup passes the place it
// recorded for the job, so a deploy can only land there, never wherever the
// active profile happens to point today.
const contextString = (key: string): string | undefined => {
  const value: unknown = app.node.tryGetContext(key)
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value !== '' ? value : undefined
}

new WalnutCloudStack(app, 'WalnutCloudStack', {
  env: {
    account: contextString('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: contextString('region') ?? process.env.CDK_DEFAULT_REGION,
  },
  description: 'Open Walnut cloud companion: always-on EC2 (Caddy + Walnut server + git data hub)',
})
