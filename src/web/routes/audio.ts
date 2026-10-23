/**
 * Audio capture routes — start/stop recording, list recordings, check status.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { audioCaptureService, type RecordingOptions } from '../../core/audio-capture.js'
import { log } from '../../logging/index.js'
import { componentStatus } from '../../core/components/index.js'

export const audioRouter = Router()

// GET /api/audio/status
audioRouter.get('/status', (_req: Request, res: Response) => {
  res.json(audioCaptureService.getStatus())
})

// GET /api/audio/available
audioRouter.get('/available', (_req: Request, res: Response) => {
  const available = audioCaptureService.isAvailable()
  const permissions = available ? audioCaptureService.checkPermissions() : null
  // The addon's download (src/core/components/): Settings > Audio Capture offers it when missing.
  res.json({ available, permissions, component: componentStatus('audio-capture') })
})

// GET /api/audio/apps — list capturable applications
audioRouter.get('/apps', (_req: Request, res: Response) => {
  res.json({ apps: audioCaptureService.listApps() })
})

// POST /api/audio/start
audioRouter.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source = 'system', mode = 'on-demand', apps, chunkMinutes, sampleRate, channels } = req.body as Partial<RecordingOptions>
    const result = await audioCaptureService.start({
      source: source as RecordingOptions['source'],
      mode: mode as RecordingOptions['mode'],
      apps,
      chunkMinutes,
      sampleRate,
      channels,
    })
    res.json(result)
  } catch (err) {
    const message = (err as Error).message
    log.audio.warn('start failed', { error: message })
    res.status(400).json({ error: message })
  }
})

// POST /api/audio/stop
audioRouter.post('/stop', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await audioCaptureService.stop()
    res.json(result)
  } catch (err) {
    const message = (err as Error).message
    log.audio.warn('stop failed', { error: message })
    res.status(400).json({ error: message })
  }
})

// GET /api/audio/recordings
audioRouter.get('/recordings', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const recordings = await audioCaptureService.listRecordings()
    res.json({ recordings })
  } catch (err) {
    next(err)
  }
})
