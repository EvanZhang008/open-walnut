import { useEffect, useState } from 'react';

/**
 * The theme the page wears now: `data-theme` on <html> (useTheme sets it for a light or dark
 * pick), else the system's. Followed live, so the drawing editor switches with the console.
 */
function current(): 'light' | 'dark' {
  const pick = document.documentElement.dataset.theme;
  if (pick === 'light' || pick === 'dark') return pick;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function usePageTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const update = () => setTheme(current());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', update);
    update();
    return () => { observer.disconnect(); media?.removeEventListener('change', update); };
  }, []);
  return theme;
}
