import { expect, type Locator } from '@playwright/test'
import { PHONE_LINK_QR, phoneLinkQrModules } from '../../../web/src/components/settings/sections/cloud/phone-link-qr'

/**
 * The QR code on screen encodes exactly `link` (the phone link of BrowserAccessGroup): its pixels
 * are read back module by module in the page and compared with the QR of `link` drawn here. PNG
 * bytes differ between engines, the modules do not, so a QR of an older link (or of anything
 * else) fails.
 */
export async function expectQrEncodes(qr: Locator, link: string) {
  await expect(qr).toBeVisible()
  await expect(qr).toHaveAttribute('data-for', link)
  const want = phoneLinkQrModules(link)
  const shown = await qr.evaluate(async (el, { size, margin }) => {
    const img = new Image()
    img.src = (el as HTMLImageElement).src
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const scale = img.naturalWidth / (size + margin * 2)
    let bits = ''
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = Math.floor((margin + c + 0.5) * scale)
        const y = Math.floor((margin + r + 0.5) * scale)
        bits += pixels[(y * canvas.width + x) * 4]! < 128 ? '1' : '0'
      }
    }
    return bits
  }, { size: want.size, margin: PHONE_LINK_QR.margin })
  expect(shown).toBe(want.bits)
}
