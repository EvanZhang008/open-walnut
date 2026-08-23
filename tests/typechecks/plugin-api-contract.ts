import type { WalnutServerApi as PublicServerApi } from '../../packages/plugin-api/src/server.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'

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
