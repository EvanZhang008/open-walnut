/**
 * A forwarded call's uploaded pictures, made inline for the Mac.
 *
 * The web console on the companion uploads a pasted picture to the companion's own
 * POST /api/images/upload and then names it (`imageRefs`) in the call that sends it: a
 * letter answer or reply, a thread reply on a card, a Board message. That file is on THIS
 * box; the Mac the call is forwarded to cannot read it, so it refused every such picture
 * ("no longer on the server"). Here, before the call leaves, the named files are read and
 * the call carries them inline (`images: [{ data, mediaType }]`), the shape the phone
 * already posts and every Mac route already takes (saveAnswerPictures).
 */
import type { Request, Response } from 'express'

/**
 * True when the call may go on (its pictures now inline, or it named none); false when it
 * was answered here: a named picture that is not on this box, refused as the Mac's own
 * route would refuse it, so the box keeps the words and pictures for another try.
 */
export async function picturesGoInline(req: Request, res: Response): Promise<boolean> {
  const b = req.body as Record<string, unknown> | undefined
  if (!b || typeof b !== 'object' || !Array.isArray(b.imageRefs) || b.imageRefs.length === 0) return true
  // A call that also carries its own `images` keeps them as they came: one kind per call.
  if (Array.isArray(b.images) && b.images.length > 0) return true
  const [{ inlineAnswerPictures }, { isImageAttachError }] = await Promise.all([
    import('../../core/answer-pictures.js'),
    import('../routes/images.js'),
  ])
  try {
    const images = await inlineAnswerPictures(b)
    const { imageRefs: _sent, ...rest } = b
    req.body = { ...rest, images }
    return true
  } catch (err) {
    if (!isImageAttachError(err)) throw err
    res.status(err.status).json({ error: { code: err.code, message: err.message } })
    return false
  }
}
