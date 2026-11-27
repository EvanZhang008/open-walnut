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

// The shared choice controls a plugin draws (Segmented, Tabs, Checkbox, Radio, Switch, Chip): the public props are the
// ones the host's views take, both ways.
type PublicSegmented = NonNullable<PublicWebApi['ui']['views']['Segmented']>
type HostSegmented = HostWebApi['ui']['views']['Segmented']
type PublicTabs = NonNullable<PublicWebApi['ui']['views']['Tabs']>
type HostTabs = HostWebApi['ui']['views']['Tabs']
type PublicCheckbox = NonNullable<PublicWebApi['ui']['views']['Checkbox']>
type HostCheckbox = HostWebApi['ui']['views']['Checkbox']
type PublicRadio = NonNullable<PublicWebApi['ui']['views']['Radio']>
type HostRadio = HostWebApi['ui']['views']['Radio']
type PublicSwitch = NonNullable<PublicWebApi['ui']['views']['Switch']>
type HostSwitch = HostWebApi['ui']['views']['Switch']
type PublicChip = NonNullable<PublicWebApi['ui']['views']['Chip']>
type HostChip = HostWebApi['ui']['views']['Chip']
const choiceViewsBothWays: [PublicSegmented, HostSegmented, PublicTabs, HostTabs, PublicCheckbox, HostCheckbox, PublicRadio, HostRadio, PublicSwitch, HostSwitch, PublicChip, HostChip] = [
  null as unknown as HostSegmented, null as unknown as PublicSegmented,
  null as unknown as HostTabs, null as unknown as PublicTabs,
  null as unknown as HostCheckbox, null as unknown as PublicCheckbox,
  null as unknown as HostRadio, null as unknown as PublicRadio,
  null as unknown as HostSwitch, null as unknown as PublicSwitch,
  null as unknown as HostChip, null as unknown as PublicChip,
]
void choiceViewsBothWays

// An App's session pane and the drawing view: the public props are the ones the host draws,
// field for field (a field missing on the host side is one the pane never gets).
type PublicSessionAppProps = import('../../packages/plugin-api/src/web.js').SessionAppProps
type HostSessionAppProps = import('../../web/src/plugins/types.js').PluginSessionAppProps
type PaneSdkOnly = ExpectNever<Exclude<keyof PublicSessionAppProps, keyof HostSessionAppProps>>
type PaneHostOnly = ExpectNever<Exclude<keyof HostSessionAppProps, keyof PublicSessionAppProps>>
type PublicSessionPane = NonNullable<import('../../packages/plugin-api/src/web.js').AppContribution['sessionPane']>
type HostSessionPane = NonNullable<Parameters<HostWebApi['ui']['app']>[0]['sessionPane']>
const hostPaneIsPublic: PublicSessionPane = null as unknown as HostSessionPane
const publicPaneIsHost: HostSessionPane = null as unknown as PublicSessionPane
void (null as unknown as PaneSdkOnly)
void (null as unknown as PaneHostOnly)
void hostPaneIsPublic
void publicPaneIsHost
const paneApp = hostApi.ui.app({
  id: 'sketch',
  title: 'Sketch',
  component: () => null,
  sessionPane: ({ sessionId, paneId, documentPath, onDocumentPathChange, onClose }) => {
    const id: string = `${sessionId}:${paneId}`
    const doc: string | undefined = documentPath
    onDocumentPathChange(doc ?? null)
    void id; void onClose
    return null
  },
})
void paneApp
type PublicDrawingView = NonNullable<PublicWebApi['ui']['views']['DrawingView']>
type HostDrawingView = HostWebApi['ui']['views']['DrawingView']
const hostDrawingIsPublic: PublicDrawingView = null as unknown as HostDrawingView
const publicDrawingIsHost: HostDrawingView = null as unknown as PublicDrawingView
void hostDrawingIsPublic
void publicDrawingIsHost

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
