/**
 * A device token the iPhone app holds: a QR pairing that never said it is anything but a phone.
 * Never a browser signed in with a code, the browser extension, or a machine credential, whose
 * tokens a page or an extension holds (2026-11-12 review: a paired browser could otherwise add a
 * signing key with WebCrypto and no Face ID). Read where the phone's token was checked: this
 * server's own routes (routes/approvals-v1.ts), or the cloud companion before it carries the call
 * to the Mac (v1-forward/forwarded-device.ts), since a pairing's name can differ between the two.
 */
export async function isPairedPhoneApp(name: string): Promise<boolean> {
  const { readDeviceRegistry } = await import('../device-auth.js')
  const { isBrowserSignInRecord } = await import('../device-store.js')
  const d = (await readDeviceRegistry()).devices.find((x) => x.name === name)
  return !!d && d.kind !== 'machine' && !isBrowserSignInRecord(d) && !/^extension-/i.test(d.name) && d.platform !== 'other'
}
