import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { startPluginFixture, openPlugins, ensureSourceInstalled, expandSidebar, type PluginFixture } from './plugin-update-fixture'
import { isolateUiPrefsContext } from './status-section-helpers'

let fixture: PluginFixture
const evidence = '/tmp/walnut-plugin-dialog'
test.use({ viewport: { width: 1200, height: 800 } })
test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => { test.setTimeout(180_000); await fs.mkdir(evidence, { recursive: true }); fixture = await startPluginFixture() })
test.afterAll(async () => { await fixture?.stop() })

// A generic plugin in the fixture's temporary home. No login, external account or real job.
const server = `
export function activate(walnut) {
  walnut.registry.op({ name: 'notice', title: 'Dialog notice', description: 'Open a fixture record', readonly: false,
    handler: async () => { await walnut.notifications.notify({ kind: 'reminder', title: 'Fixture record ready', dedupKey: 'record', actions: [{ label: 'Open record', dialog: 'record', args: { id: 'record-one' } }] }); return {}; } });
  walnut.registry.op({ name: 'open', title: 'Open dialog', description: 'Open the fixture dialog in each window', readonly: false,
    handler: async () => { walnut.events.emit('open-dialog', {}); return {}; } });
}
`
const web = `
export async function activate(walnut) {
  const { React, ReactDOM } = globalThis.__WALNUT_PLUGIN_HOST__;
  const { ConfirmDialog } = await import(new URL('/src/components/common/ConfirmDialog.tsx', window.location.origin).href);
  const { Lightbox } = await import(new URL('/src/components/common/Lightbox.tsx', window.location.origin).href);
  const { useModalOverlay } = await import(new URL('/src/hooks/useModalOverlay.ts', window.location.origin).href);
  const { usePhoneOverlay } = await import(new URL('/src/hooks/usePhoneOverlayHistory.ts', window.location.origin).href);
  const h = React.createElement;
  function ChildPortal({close}) {
    const ref = React.useRef(null);
    React.useEffect(() => { const before = document.activeElement; ref.current?.querySelector('input')?.focus(); return () => { if (before?.isConnected) before.focus(); }; }, []);
    return ReactDOM.createPortal(h('div', {ref, role: 'menu', 'aria-label': 'Record options', style: {position: 'fixed', top: '100px', right: '40px', zIndex: 9250, background: 'var(--bg-secondary)', color: 'var(--fg)', padding: '16px'}, onPointerDown: e => e.stopPropagation(), onKeyDown: e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Tab') { e.preventDefault(); const stops = [...ref.current.querySelectorAll('input,button')]; const at = stops.indexOf(document.activeElement); stops[(at + (e.shiftKey ? stops.length - 1 : 1)) % stops.length].focus(); }
    }}, h('input', {'aria-label': 'Option note'}), h('button', {onClick: () => { window.__portalActions = (window.__portalActions || 0) + 1; close(); }}, 'Apply option')), document.body);
  }
  function UnderlyingModal({close}) {
    const layer = usePhoneOverlay({id: 'sheet:fixture-task', kind: 'sheet', open: true, onClose: close});
    useModalOverlay(layer.close);
    return ReactDOM.createPortal(h('div', {'data-testid': 'underlying-dialog', style: {position: 'fixed', inset: '20px', zIndex: 9100, background: 'var(--bg-secondary)', color: 'var(--fg)'}},
      h('button', {onClick: () => walnut.ui.openDialog('record', {id: 'underlying-record'})}, 'Open over task'), h('button', {onClick: layer.close}, 'Close task')), document.body);
  }
  const Late = React.lazy(() => new Promise(resolve => { window.__resolveLateDialog = () => resolve({default: () => { React.useEffect(() => { window.__lateDialogMounts = (window.__lateDialogMounts || 0) + 1; }, []); return h('p', null, 'Late dialog mounted'); }}); }));
  walnut.ui.injectCss('.dialog-fixture-marker { color: inherit; }');
  function Record({args, close, navigate}) {
    const [value, setValue] = React.useState('');
    const [portal, setPortal] = React.useState(false);
    const [confirm, setConfirm] = React.useState(args?.initialConfirm === true);
    const [image, setImage] = React.useState(args?.initialConfirm === true);
    React.useEffect(() => { window.__dialogMounts = (window.__dialogMounts || 0) + 1; return () => { window.__dialogCleanups = (window.__dialogCleanups || 0) + 1; }; }, []);
    return h('div', null,
      h('p', null, args?.id || 'No record'),
      h('label', null, 'Record note', h('input', { 'aria-label': 'Record note', autoFocus: true, value, onChange: e => setValue(e.target.value) })),
      h('button', { onClick: () => walnut.ui.openDialog('record', {id: 'changed'}) }, 'Open same dialog'),
      h('button', { onClick: () => walnut.ui.openDialog('other') }, 'Open another dialog'),
      h('button', { onClick: () => navigate('https://example.com') }, 'Try external navigation'),
      h('button', { onClick: close }, 'Finish record'),
      h('button', { onClick: e => { e.currentTarget.focus(); setPortal(true); } }, 'Open record options'),
      h('button', { onClick: () => setConfirm(true) }, 'Confirm record'),
      portal && h(ChildPortal, {close: () => setPortal(false)}),
      confirm && h(ConfirmDialog, {title: 'Confirm fixture record', confirmLabel: 'Confirm', cancelLabel: 'Cancel', promptDefaultValue: args?.initialConfirm ? '' : undefined, onConfirm: () => setConfirm(false), onCancel: () => setConfirm(false), message: image && h(Lightbox, {src: '/walnut-icon.png', onClose: () => setImage(false)})}),
      h('button', { onClick: () => navigate('/settings') }, 'Open settings'),
      h('div', { style: { height: '1000px', width: '1400px' } }, 'Long record content'));
  }
  function App() { const [task, setTask] = React.useState(false); return h('div', { 'data-testid': 'dialog-fixture-app' },
    h('p', { 'data-testid': 'dialog-fixture-version' }, 'Fixture app version 1'),
    task && h(UnderlyingModal, {close: () => setTask(false)}),
    h('button', {onClick: () => setTask(true)}, 'Open task modal'),
    h('button', {onClick: () => walnut.ui.openDialog('late', {id: 'late-record'})}, 'Open slow dialog'),
    h('button', { onClick: () => walnut.ui.openDialog('record', {id: 'record-one'}) }, 'Open dialog'),
    h('button', { onClick: () => walnut.ui.openDialog('record', {id: 'initial-record', initialConfirm: true}) }, 'Open initial confirmation'),
    h('button', { onClick: () => walnut.ops.call('walnut_demo_notice') }, 'Send notice'),
    h('button', { onClick: () => walnut.ui.openDialog('missing') }, 'Open missing dialog'),
    h('button', { onClick: () => walnut.ui.openDialog('empty') }, 'Open empty dialog'),
    h('button', { onClick: () => walnut.ui.openDialog('crash') }, 'Open failing dialog')) }
  walnut.ui.app({id: 'main', title: 'Dialog Fixture', placement: 'sidebar', component: App});
  walnut.ui.slot({id: 'record', target: 'dialog', title: 'Fixture record', component: Record});
  walnut.ui.slot({id: 'other', target: 'dialog', title: 'Other record', component: () => h('p', null, 'Wrong dialog mounted')});
  walnut.ui.slot({id: 'late', target: 'dialog', title: 'Slow record', component: Late});
  walnut.ui.slot({id: 'empty', target: 'dialog', title: 'Empty record', component: () => null});
  walnut.ui.slot({id: 'crash', target: 'dialog', title: 'Failing record', component: () => { throw new Error('Fixture render failure') }});
  walnut.events.on('plugin:walnut-demo:open-dialog', () => walnut.ui.openDialog('record', {id: 'popout-record'}));
}
`

async function screenshot(page: Page, name: string) {
  const file = path.join(evidence, name)
  await page.screenshot({ path: file, scale: 'css' })
  await test.info().attach(name, { path: file, contentType: 'image/png' })
  const exported = path.join(process.cwd(), '.put/plugin-dialog-shots')
  await fs.mkdir(exported, { recursive: true })
  await fs.copyFile(file, path.join(exported, name))
}

async function enter(page: Page, pathname = '/') {
  await page.setContent(`<a href="http://127.0.0.1:${fixture.port}${pathname}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
}
async function openApp(page: Page) {
  const menu = page.locator('.phone-topbar').getByRole('button', { name: 'Menu', exact: true })
  if (await menu.isVisible()) await menu.click()
  await expandSidebar(page)
  await page.getByTestId('sidebar-app-walnut-demo:main').click()
  await expect(page.getByTestId('dialog-fixture-app')).toBeVisible({ timeout: 30_000 })
  if (await menu.isVisible()) await expect(page.locator('.sidebar')).toBeHidden()
}
async function op(page: Page, name: string) {
  const response = await page.request.post(`http://127.0.0.1:${fixture.port}/api/plugin-runtime/walnut-demo/ops/walnut_demo_${name}`, { data: {} })
  expect(response.ok(), await response.text()).toBe(true)
  expect((await response.json()).ok).toBe(true)
}
async function reload(page: Page) {
  const response = await page.request.post(`http://127.0.0.1:${fixture.port}/api/plugin-runtime/walnut-demo/reload`)
  expect(response.ok(), await response.text()).toBe(true)
}

test('owns one dialog, keeps duplicate work, closes cleanly and handles reloads in both windows', async ({ page, context }, info) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await isolateUiPrefsContext(context)
  await enter(page)
  await openPlugins(page)
  await ensureSourceInstalled(page, fixture.home)
  const root = path.join(fixture.home, 'plugin-stores/native-plugin-repo/dist')
  const webFile = path.join(root, 'web.mjs')
  const serverFile = path.join(root, 'server.mjs')
  const originalWeb = await fs.readFile(webFile, 'utf8')
  const originalServer = await fs.readFile(serverFile, 'utf8')
  try {
    await fs.writeFile(webFile, web)
    await fs.writeFile(serverFile, server)
    await reload(page)
    await openApp(page)
    const dialog = page.getByTestId('plugin-dialog')
    const note = dialog.getByRole('textbox', { name: 'Record note' })
    const trigger = page.getByRole('button', { name: 'Open dialog', exact: true })
    await trigger.focus()
    await trigger.click()
    await expect(dialog).toHaveAccessibleName('Fixture record')
    await expect(note).toBeFocused()
    await dialog.getByRole('button', { name: 'Open record options' }).click()
    const portal = page.getByRole('menu', { name: 'Record options' })
    await expect(portal.getByRole('textbox', { name: 'Option note' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(portal.getByRole('button', { name: 'Apply option' })).toBeFocused()
    await portal.getByRole('button', { name: 'Apply option' }).click()
    await expect(portal).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).__portalActions)).toBe(1)
    await expect(dialog.getByRole('button', { name: 'Open record options' })).toBeFocused()
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Open record options' }).click()
    await page.keyboard.press('Escape')
    await expect(portal).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Open record options' })).toBeFocused()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Confirm record' }).click()
    const confirm = page.getByRole('dialog', { name: 'Confirm fixture record', exact: true })
    await expect(confirm).toBeVisible()
    await expect(confirm.getByRole('button', { name: 'Confirm', exact: true })).toBeFocused()
    // The confirmation really paints above the plugin, not just later in the DOM.
    expect(await confirm.evaluate(el => { const box = el.querySelector('.app-modal')!.getBoundingClientRect(); return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true)
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('record-one')
    await note.fill('Unsaved note')
    const mountsBeforeDuplicate = await page.evaluate(() => (window as any).__dialogMounts)
    expect(await page.evaluate(() => (window as any).__dialogMounts - ((window as any).__dialogCleanups || 0))).toBe(1)
    expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => String(value).includes('Unsaved note')))).toBe(false)
    await dialog.getByRole('button', { name: 'Open same dialog' }).click()
    await dialog.getByRole('button', { name: 'Open another dialog' }).click()
    await expect(note).toHaveValue('Unsaved note')
    await expect(dialog).not.toContainText('Wrong dialog mounted')
    expect(await page.evaluate(() => (window as any).__dialogMounts)).toBe(mountsBeforeDuplicate)
    await dialog.getByRole('button', { name: 'Try external navigation' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('This dialog can only open paths within Walnut.')
    await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
    await dialog.getByRole('button', { name: 'Close dialog' }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: 'Open settings' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused()
    await note.focus()
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press(i % 2 ? 'Shift+Tab' : 'Tab')
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
    }
    await screenshot(page, `${info.project.name}-light.png`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
    expect(await page.evaluate(() => (window as any).__dialogCleanups)).toBe(mountsBeforeDuplicate)
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')

    await trigger.click()
    await dialog.getByRole('button', { name: 'Finish record' }).click()
    await expect(dialog).toHaveCount(0)
    await trigger.click()
    await dialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(dialog).toHaveCount(0)

    await page.getByRole('button', { name: 'Open initial confirmation', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Image preview', exact: true })).toBeVisible()
    await page.getByRole('dialog', { name: 'Confirm fixture record', exact: true }).locator('input').focus()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Image preview', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Confirm fixture record', exact: true })).toBeVisible()
    await expect(dialog).toContainText('initial-record')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Confirm fixture record', exact: true })).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Toast entry, then the persisted feed entry use the same dispatcher.
    await page.getByRole('button', { name: 'Send notice' }).click()
    const toastAction = page.locator('.notification-toast').getByRole('button', { name: 'Open record', exact: true })
    await expect(toastAction).toBeVisible({ timeout: 30_000 })
    await toastAction.click()
    await expect(dialog).toContainText('record-one')
    await page.keyboard.press('Escape')
    await page.locator('.sidebar-notification-btn').click()
    await page.locator('.notification-panel').getByRole('button', { name: 'All', exact: true }).click()
    const cardAction = page.locator('.notification-panel').getByRole('button', { name: 'Open record', exact: true })
    await expect(cardAction).toBeVisible()
    await cardAction.focus()
    await cardAction.click()
    await expect(dialog).toContainText('record-one')
    await expect(note).toBeFocused()
    await note.focus()
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(cardAction).toBeFocused()
    // A second Escape closes the notification panel, not the dialog's old layer.
    await page.keyboard.press('Escape')
    await expect(page.locator('.notification-panel')).toHaveCount(0)

    for (const [button, message] of [
      ['Open missing dialog', 'This dialog is unavailable.'],
      ['Open empty dialog', 'The plugin has no dialog content to show.'],
      ['Open failing dialog', 'The plugin could not render this dialog.'],
    ]) {
      await page.getByRole('button', { name: button, exact: true }).click()
      await expect(dialog).toContainText(message)
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }
    await page.getByRole('button', { name: 'Open slow dialog' }).click()
    await expect(dialog).toContainText('Loading dialog content')
    await expect(dialog).toContainText('did not finish loading', { timeout: 35_000 })
    await page.evaluate(async () => { (window as any).__resolveLateDialog(); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
    await expect(dialog).not.toContainText('Late dialog mounted')
    expect(await page.evaluate(() => (window as any).__lateDialogMounts || 0)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.getByRole('button', { name: 'Open task modal' }).click()
    const underlying = page.getByTestId('underlying-dialog')
    await underlying.getByRole('button', { name: 'Open over task' }).click()
    await expect(dialog).toContainText('underlying-record')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(underlying).toBeVisible()
    await underlying.getByRole('button', { name: 'Open over task' }).click()
    await dialog.getByRole('button', { name: 'Open settings' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(underlying).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings$/)
    await openApp(page)

    await trigger.click()
    await note.fill('Discard on same-module reload')
    await reload(page)
    await expect(dialog.getByRole('alert')).toContainText(/changed|unavailable/)
    await expect(note).toHaveCount(0)
    await page.keyboard.press('Escape')
    await trigger.click()
    await expect(note).toHaveValue('')
    await note.fill('Discard on reload')
    await fs.writeFile(webFile, web.replace('Fixture record', 'Updated record').replace('Fixture app version 1', 'Fixture app version 2'))
    await reload(page)
    await expect(dialog.getByRole('alert')).toContainText('changed or became unavailable')
    await expect(note).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('dialog-fixture-version')).toHaveText('Fixture app version 2')
    await trigger.click()
    await expect(dialog).toHaveAccessibleName('Updated record')
    await expect(note).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await page.setViewportSize({ width: 390, height: 600 })
    await trigger.click()
    await expect(dialog).toBeVisible()
    await expect.poll(() => page.evaluate(() => (history.state as any)?.walnutOverlay?.id)).toMatch(/^plugin-dialog:/)
    const rect = (await dialog.boundingBox())!
    expect(rect.x).toBeGreaterThanOrEqual(0)
    expect(rect.x + rect.width).toBeLessThanOrEqual(390)
    expect(rect.y + rect.height).toBeLessThanOrEqual(600)
    expect(await dialog.locator('.plugin-dialog-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\([^)]*,\s*0\)|transparent/)
    await screenshot(page, `${info.project.name}-dark-narrow.png`)
    await page.goBack()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
    await expect.poll(() => page.evaluate(() => (history.state as any)?.walnutOverlay)).toBeUndefined()
    await trigger.click()
    await dialog.getByRole('button', { name: 'Open settings' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings$/)
    await expect.poll(() => page.evaluate(() => (history.state as any)?.walnutOverlay)).toBeUndefined()
    await openApp(page)
    await page.getByRole('button', { name: 'Open task modal' }).click()
    await underlying.getByRole('button', { name: 'Open over task' }).click()
    await expect(dialog).toContainText('underlying-record')
    await dialog.getByRole('button', { name: 'Open settings' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(underlying).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings$/)
    await expect.poll(() => page.evaluate(() => (history.state as any)?.walnutOverlay)).toBeUndefined()
    await page.goBack()
    await expect(page).toHaveURL(/\/apps\/walnut-demo~main$/)
    await expect(dialog).toHaveCount(0)
    await expect(underlying).toHaveCount(0)
    await page.setViewportSize({ width: 1200, height: 800 })
    await openApp(page)

    const popout = await context.newPage()
    await enter(popout, '/popout?view=unknown')
    await expect(popout.getByRole('heading', { name: 'Unknown view' })).toBeVisible({ timeout: 90_000 })
    await expect.poll(async () => (await popout.request.get(`http://127.0.0.1:${fixture.port}/api/plugin-runtime`)).ok()).toBe(true)
    // Wait for the popout's plugin activation before broadcasting through its real socket.
    await expect(popout.locator('style[data-walnut-plugin="walnut-demo"]')).toHaveCount(1, { timeout: 30_000 })
    await op(page, 'open')
    const popDialog = popout.getByTestId('plugin-dialog')
    await expect(popDialog).toContainText('popout-record', { timeout: 30_000 })
    await popDialog.getByRole('button', { name: 'Close dialog' }).click()
    await expect(popDialog).toHaveCount(0)
    await expect(popout.getByRole('heading', { name: 'Unknown view' })).toBeVisible()
    await popout.close()
    await expect(dialog).toBeVisible()
    const disabled = await page.request.post(`http://127.0.0.1:${fixture.port}/api/plugin-runtime/walnut-demo/disable`)
    expect(disabled.ok()).toBe(true)
    await expect(dialog.getByRole('alert')).toContainText('changed or became unavailable')
    await expect(note).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await reload(page)
    await openApp(page)
    await trigger.click()
    await dialog.getByRole('button', { name: 'Open settings' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings$/)
    expect(pageErrors).toEqual([])
  } finally {
    await fs.writeFile(webFile, originalWeb)
    await fs.writeFile(serverFile, originalServer)
  }
})
