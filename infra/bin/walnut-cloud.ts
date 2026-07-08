#!/usr/bin/env node
/**
 * CDK app entry point for the Open Walnut cloud companion stack.
 *
 * Account/region come from the active AWS profile (CDK_DEFAULT_ACCOUNT /
 * CDK_DEFAULT_REGION) so nothing personal is hardcoded here. All deployment
 * parameters flow in via `-c key=value` context — see infra/README.md.
 */
import * as cdk from 'aws-cdk-lib'
import { WalnutCloudStack } from '../lib/walnut-cloud-stack'

const app = new cdk.App()

new WalnutCloudStack(app, 'WalnutCloudStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'Open Walnut cloud companion: always-on EC2 (Caddy + Walnut server + git data hub)',
})
