/**
 * Skills routes — CRUD + enable/disable for skill management.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  listAllSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  setSkillEnabled,
  listReferences,
  getReference,
} from '../../core/skill-store.js';
import { SKILL_READ_ONLY_INSTALL } from '../../core/skill-errors.js';

export function createSkillsRouter(): Router {
  const router = Router();

  // GET /api/skills — list all skills
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const skills = await listAllSkills();
      res.json({ skills });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/skills/:dirName — get single skill
  router.get('/:dirName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const skill = await getSkill(req.params.dirName as string);
      if (!skill) {
        res.status(404).json({ error: `Skill not found: ${req.params.dirName}` });
        return;
      }
      res.json({ skill });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills — create new skill
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { dirName, content, target } = req.body;
      if (!dirName || typeof dirName !== 'string') {
        res.status(400).json({ error: 'dirName is required' });
        return;
      }
      if (!content || typeof content !== 'string') {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const skill = await createSkill(dirName, content, target);
      res.status(201).json({ skill });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('already exists')) {
          res.status(409).json({ error: err.message });
          return;
        }
        if (err.message.includes('Invalid')) {
          res.status(400).json({ error: err.message });
          return;
        }
      }
      next(err);
    }
  });

  // PUT /api/skills/:dirName — update skill content
  router.put('/:dirName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content must be a string' });
        return;
      }
      const skill = await updateSkill(req.params.dirName as string, content);
      res.json({ skill });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err.message.includes('Cannot modify')) {
          res.status(403).json({ error: err.message });
          return;
        }
        // A shipped skill on a package the server cannot write (see skill-store).
        if (err.message.includes(SKILL_READ_ONLY_INSTALL)) {
          res.status(409).json({ error: err.message });
          return;
        }
      }
      next(err);
    }
  });

  // PATCH /api/skills/:dirName — enable/disable skill
  router.patch('/:dirName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      const skill = await setSkillEnabled(req.params.dirName as string, enabled);
      res.json({ skill });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // DELETE /api/skills/:dirName — delete skill
  router.delete('/:dirName', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await deleteSkill(req.params.dirName as string);
      res.status(204).end();
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err.message.includes('Cannot delete')) {
          res.status(403).json({ error: err.message });
          return;
        }
        // A shipped skill on a package the server cannot write (see skill-store).
        if (err.message.includes(SKILL_READ_ONLY_INSTALL)) {
          res.status(409).json({ error: err.message });
          return;
        }
      }
      next(err);
    }
  });

  // GET /api/skills/:dirName/references — list reference files
  router.get('/:dirName/references', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = await listReferences(req.params.dirName as string);
      res.json({ files });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // GET /api/skills/:dirName/references/:file — get reference file content
  router.get('/:dirName/references/:file', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const content = await getReference(req.params.dirName as string, req.params.file as string);
      res.json({ content });
    } catch (err) {
      if (err instanceof Error) {
        if (err.message === 'Invalid filename') {
          res.status(400).json({ error: err.message });
          return;
        }
        if (err.message.includes('not found')) {
          res.status(404).json({ error: err.message });
          return;
        }
      }
      next(err);
    }
  });

  return router;
}
