import './utils/trace-dispatchers';
import { initDemoGeneration, installDemoGenerationFetch, isDemoOrigin } from './utils/demo-generation';
import { holdDevLoad } from './utils/dev-load-hold-script';

// main is imported below once the Demo check answers, after `load`; in the dev server a module
// script of main itself (the address the import resolves to, so one module) keeps `load` waiting
// for it, and main's boot-shell.ts then holds it for App. Off the Demo only, where the check is
// none and the fetch hook below a no-op: on the Demo, main runs only after its generation is known.
if (import.meta.env.DEV && !isDemoOrigin()) holdDevLoad(import.meta.url.replace(/[^/]*$/, 'main.tsx'));

void initDemoGeneration().then(() => {
  installDemoGenerationFetch();
  return import('./main');
}).catch(error => {
  const root = document.getElementById('root');
  if (root) root.textContent = error instanceof Error ? error.message : 'Walnut could not open. Reload to try again.';
});
