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

const app = hostApi.ui.app({
  id: 'main',
  title: 'Example',
  component: () => null,
  badge: 'dot',
  placement: 'settings',
})
const appPath: string = app.path
app.setBadge(3)
app.setBadge(null)
void appPath

const publicLink = hostImplementsPublicContract.ui.link?.({
  id: 'chat-links',
  patterns: ['https://*.example.com/archives/*'],
  title: 'Chat',
  accepts: (url) => url.hostname.endsWith('example.com'),
  open: (url, context) => {
    context.navigate(`${appPath}?link=${encodeURIComponent(url.href)}`)
    return context.via === 'click'
  },
})
const hostLink = hostApi.ui.link({ id: 'async-links', patterns: ['*://*/*'], open: async () => false })
void publicLink
void hostLink.dispose

// A plugin's own box with Walnut's dictation: the public props must be the ones the host draws.
type PublicMicButton = NonNullable<PublicWebApi['ui']['views']['MicButton']>
type HostMicButton = HostWebApi['ui']['views']['MicButton']
const hostMicIsPublicMic: PublicMicButton = null as unknown as HostMicButton
const publicMicIsHostMic: HostMicButton = null as unknown as PublicMicButton
void hostMicIsPublicMic
void publicMicIsHostMic
