/**
 * What a screenshot does with the picture it took (agent-shot.ts): numbers drawn on the elements
 * of an annotated one, and the crop of a zoom at the picture's full resolution. Both drawn in the
 * extension's own OffscreenCanvas; the page draws nothing.
 */
import { layoutLabels, zoomCrop, type LabelBox } from './input-math'

export function base64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function bitmapOf(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob())
}

async function encode(canvas: OffscreenCanvas, png: boolean): Promise<string> {
  const type = png ? 'image/png' : 'image/jpeg'
  const blob = await canvas.convertToBlob(png ? { type } : { type, quality: 0.8 })
  return `data:${type};base64,${base64(await blob.arrayBuffer())}`
}

/** The picture with each element's box outlined and its number on a tag at its top left corner. */
export async function drawLabels(dataUrl: string, boxes: LabelBox[], viewportW: number, png: boolean): Promise<string> {
  const bmp = await bitmapOf(dataUrl)
  const canvas = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const scale = viewportW > 0 ? bmp.width / viewportW : 1
  ctx.lineWidth = Math.max(1, Math.round(1.5 * scale))
  ctx.textBaseline = 'middle'
  ctx.font = `bold ${Math.round(11 * scale)}px sans-serif`
  for (const l of layoutLabels(boxes, scale, bmp.width, bmp.height)) {
    ctx.strokeStyle = 'rgba(230, 40, 120, 0.9)'
    ctx.strokeRect(l.box.x, l.box.y, l.box.w, l.box.h)
    ctx.fillStyle = 'rgba(230, 40, 120, 0.95)'
    ctx.fillRect(l.tag.x, l.tag.y, l.tag.w, l.tag.h)
    ctx.fillStyle = '#fff'
    ctx.fillText(String(l.label), l.tag.x + Math.round(4 * scale), l.tag.y + l.tag.h / 2)
  }
  bmp.close()
  return encode(canvas, png)
}

/** The region (CSS pixels of the viewport) of the picture, at the picture's own pixels. */
export async function cropPicture(dataUrl: string, region: { x: number; y: number; width: number; height: number }, viewportW: number, png: boolean): Promise<{ image: string; width: number; height: number; scale: number } | null> {
  const bmp = await bitmapOf(dataUrl)
  const crop = zoomCrop(region, viewportW, bmp.width, bmp.height)
  if (!crop) { bmp.close(); return null }
  const canvas = new OffscreenCanvas(crop.sw, crop.sh)
  canvas.getContext('2d')!.drawImage(bmp, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh)
  bmp.close()
  return { image: await encode(canvas, png), width: crop.sw, height: crop.sh, scale: crop.scale }
}
