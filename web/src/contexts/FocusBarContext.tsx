import { createContext, useContext, type ReactNode } from 'react';
import { useFocusBar, type UseFocusBarReturn } from '@/hooks/useFocusBar';
import { useTasksContext } from './TasksContext';

const FocusBarContext = createContext<UseFocusBarReturn | null>(null);

export function FocusBarProvider({ children }: { children: ReactNode }) {
  const { tasks } = useTasksContext();
  const focusBar = useFocusBar(tasks);
  return <FocusBarContext.Provider value={focusBar}>{children}</FocusBarContext.Provider>;
}

export function useFocusBarContext(): UseFocusBarReturn {
  const ctx = useContext(FocusBarContext);
  if (!ctx) throw new Error('useFocusBarContext must be used within FocusBarProvider');
  return ctx;
}
