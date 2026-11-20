/**
 * Reflection over the sessions a node manages (2026-11-19, the user: "create a reflection process
 * ... the reflection for the session it managed, look at this, it is stupid, it just make some
 * stupid decision"; then: "it should reflect on the stupid thing they did, I angry, I frustrated",
 * "his decision is different from mine ... or can be improved, like we talk for 10 round but could
 * just be one"). The runner lives in src/core/org/reflection/.
 */
import type { OrgDuty } from './types.js';

export const reflectionDuty: OrgDuty = {
  id: 'reflection',
  name: 'Reflect on the sessions it manages',
  description: 'Finds where the user was frustrated, overruled a session\'s decision, needed many rounds for one answer, '
    + 'said something broke, is not what he asked for or shows twice, got an ask that was not his, or an answer in the wrong language; '
    + 'tells that session what went wrong and writes the lesson as team guidance.',
  roles: ['main', 'lead'],
  start: () => {
    let stop: (() => void) | undefined;
    let stopped = false;
    void import('../reflection/runner.js').then((m) => {
      if (!stopped) stop = m.startReflectionRunner();
    });
    return () => { stopped = true; stop?.(); };
  },
};
