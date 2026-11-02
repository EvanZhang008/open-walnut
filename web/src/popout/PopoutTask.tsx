import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { taskPath } from '@/utils/task-path';

/**
 * An old `/popout?view=task&id=…` link. The task page is gone (utils/task-path.ts), so the tab
 * goes to the task on Home: `/tasks/<id>` renders the whole app and opens the task there.
 */
export function PopoutTask() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const id = params.get('id') ?? '';
  useEffect(() => {
    navigate(id ? taskPath(id) : '/', { replace: true });
  }, [id, navigate]);
  return null;
}
