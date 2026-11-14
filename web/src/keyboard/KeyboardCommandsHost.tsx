/**
 * The commands no page owns (keyboard/commands.ts): New task from any page, and showing or
 * hiding Home's task panel. The page-bound ones are handled where their page is (Home's keys in
 * pages/useHomeKeyboard.ts, the task search in TodoSearchBar); each says where in commands.ts.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { isTypingTarget } from '@/components/tasks/useHomeFilters';
import { commandAt } from './shortcut-overrides';
import { detectKeyEnv } from './shortcuts';

export function KeyboardCommandsHost() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    const onHome = pathname === '/';
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const id = commandAt(e);
      if (!id) return;
      switch (id) {
        case 'task.new': {
          if (hasActiveModalOverlay()) return;
          // A Mac's text boxes keep Ctrl+N (the line below): a browser's ⌃N waits for the caret
          // to leave the box.
          if (detectKeyEnv() === 'mac-browser' && e.ctrlKey && isTypingTarget(document.activeElement)) return;
          e.preventDefault();
          if (e.repeat) return;
          // Home stays mounted behind every other page: its draft column opens there.
          if (!onHome) navigate('/');
          window.dispatchEvent(new CustomEvent('task-composer:open'));
          return;
        }
        case 'panel.tasks': {
          if (!onHome || hasActiveModalOverlay()) return;
          e.preventDefault();
          if (e.repeat) return;
          window.dispatchEvent(new CustomEvent('sidebar:toggle-todo'));
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, pathname]);
  return null;
}
