import type { WalnutWebApi as PublicWebApi } from '../../packages/plugin-api/src/web.js'
import type { WalnutWebApiHost as HostWebApi } from '../../web/src/plugins/types.js'
import type { ContentItem as SdkContentItem } from '../../packages/plugin-api/src/content-actions.js'
import type { ContentItem as CoreContentItem } from '../../src/core/content-actions/content-item.js'

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

// The content item a plugin hands to walnut.content is the one the server reads, field for field.
type ContentSdkOnly = ExpectNever<Exclude<keyof SdkContentItem, keyof CoreContentItem>>
type ContentCoreOnly = ExpectNever<Exclude<keyof CoreContentItem, keyof SdkContentItem>>
const sdkItemIsCore: CoreContentItem = null as unknown as SdkContentItem
const coreItemIsSdk: SdkContentItem = null as unknown as CoreContentItem
void (null as unknown as ContentSdkOnly)
void (null as unknown as ContentCoreOnly)
void sdkItemIsCore
void coreItemIsSdk
const contentActions = hostApi.content.actions({ source: 'Chat', title: 'Review the plan' })
const firstActionLabel: string = contentActions[0].label
void firstActionLabel

// walnut.passwords: the host always has it; a plugin reads it as optional and never gets a value back.
const pinSave: Promise<import('../../packages/plugin-api/src/web.js').PasswordSaveResult> = hostApi.passwords.save({ title: 'Example PIN', password: 'fake' })
const pwState: Promise<import('../../packages/plugin-api/src/web.js').PasswordsState> = hostApi.passwords.state()
const pwUnlock: Promise<boolean> = hostApi.passwords.unlock({ reason: 'to save your PIN' })
void pinSave; void pwState; void pwUnlock

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

hostApi.ui.slot({
  id: 'record', target: 'dialog', title: 'Record',
  component: ({ args, close, navigate }) => {
    const record: unknown = args?.record
    void record
    void close
    void navigate
    return null
  },
})
const dialogOpened: boolean | undefined = hostImplementsPublicContract.ui.openDialog?.('record', { record: 'one' })
void dialogOpened
