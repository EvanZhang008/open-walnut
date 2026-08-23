import type { WalnutWebApi as PublicWebApi } from '../../packages/plugin-api/src/web.js'
import type { WalnutWebApiHost as HostWebApi } from '../../web/src/plugins/types.js'

type IsAny<T> = 0 extends (1 & T) ? true : false
type ExpectFalse<T extends false> = T
type ExpectNever<T extends never> = T

type HostApiMustNotBeAny = ExpectFalse<IsAny<HostWebApi>>
type HostOnlyKeys = ExpectNever<Exclude<keyof HostWebApi, keyof PublicWebApi>>
type PublicOnlyKeys = ExpectNever<Exclude<keyof PublicWebApi, keyof HostWebApi>>

declare const hostApi: HostWebApi
const hostImplementsPublicContract: PublicWebApi = hostApi

void (null as unknown as HostApiMustNotBeAny)
void (null as unknown as HostOnlyKeys)
void (null as unknown as PublicOnlyKeys)
void hostImplementsPublicContract
