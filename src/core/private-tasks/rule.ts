/**
 * The rule agents read about private tasks: the session prompt (session-context.ts) and the
 * task_create op's `local` field say it, so a task an agent files about the user's private
 * matters never reaches an outside service, whatever its project syncs to.
 */
export const PRIVATE_TASK_RULE =
  'Private matters (the user\'s own promotion or performance, feedback on a colleague, pay, health, '
  + 'immigration, money, family, a job search, a side project) are created with local:true '
  + '(task_create): nothing of them reaches an outside service a project syncs to.';
