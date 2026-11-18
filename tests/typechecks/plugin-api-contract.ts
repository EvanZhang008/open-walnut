import type { WalnutServerApi as PublicServerApi, WalnutJobApi as PublicJobApi } from '../../packages/plugin-api/src/server.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import type { PluginJobHarness } from '../../src/providers/plugin-job-harness.js'

type HostServerApi = ReturnType<typeof createServerPluginApi>
type IsAny<T> = 0 extends (1 & T) ? true : false
type ExpectFalse<T extends false> = T
type ExpectNever<T extends never> = T

type HostApiMustNotBeAny = ExpectFalse<IsAny<HostServerApi>>
type HostOnlyKeys = ExpectNever<Exclude<keyof HostServerApi, keyof PublicServerApi>>
type PublicOnlyKeys = ExpectNever<Exclude<keyof PublicServerApi, keyof HostServerApi>>

declare const hostApi: HostServerApi
const hostImplementsPublicContract: PublicServerApi = hostApi

void (null as unknown as HostApiMustNotBeAny)
void (null as unknown as HostOnlyKeys)
void (null as unknown as PublicOnlyKeys)
void hostImplementsPublicContract

// A job's `walnut` (plugin-job-harness.ts) is the WalnutJobApi a plugin is promised, key for key.
type HostJobApi = ReturnType<PluginJobHarness['makeWalnut']>['walnut']
type HostJobMustNotBeAny = ExpectFalse<IsAny<HostJobApi>>
type HostJobOnlyKeys = ExpectNever<Exclude<keyof HostJobApi, keyof PublicJobApi>>
type PublicJobOnlyKeys = ExpectNever<Exclude<keyof PublicJobApi, keyof HostJobApi>>

declare const hostJob: HostJobApi
const hostJobImplementsPublicContract: PublicJobApi = hostJob

void (null as unknown as HostJobMustNotBeAny)
void (null as unknown as HostJobOnlyKeys)
void (null as unknown as PublicJobOnlyKeys)
void hostJobImplementsPublicContract
