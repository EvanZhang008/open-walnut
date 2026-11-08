import './utils/trace-dispatchers';
import { initDemoGeneration, installDemoGenerationFetch } from './utils/demo-generation';

void initDemoGeneration().then(() => {
  installDemoGenerationFetch();
  return import('./main');
}).catch(error => {
  const root = document.getElementById('root');
  if (root) root.textContent = error instanceof Error ? error.message : 'Walnut could not open. Reload to try again.';
});
