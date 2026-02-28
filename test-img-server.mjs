import express from 'express';
import path from 'node:path';
import fsp from 'node:fs/promises';

const IMAGES_DIR = path.join(process.env.WALNUT_HOME || path.join(process.env.HOME, '.walnut'), 'images'); // safe: production-path
const EXT_TO_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const app = express();
app.get('/api/images/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[\w.-]+$/.test(filename)) return res.status(400).json({ error: 'Invalid' });
  const filePath = path.join(IMAGES_DIR, filename);
  try { await fsp.access(filePath); } catch { return res.status(404).json({ error: 'Not found' }); }
  const ext = path.extname(filename).slice(1).toLowerCase();
  const buffer = await fsp.readFile(filePath);
  res.setHeader('Content-Type', EXT_TO_MIME[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});
app.listen(3459, () => console.log('Image test server on 3459'));
