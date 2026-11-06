import { isBoolean, usePageView } from '@/utils/view-memory';

export function useTaskStatusLines(): [boolean, (show: boolean) => void] {
  return usePageView('tasks', 'statusLines', false, isBoolean);
}
