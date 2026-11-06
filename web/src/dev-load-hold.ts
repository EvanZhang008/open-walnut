/**
 * The dev server only: boot-shell.ts adds this as a module script, so the page's load event
 * waits for the console's own modules (a dynamic import never holds it). Imported here by the
 * same specifiers boot-shell.ts imports them by, so the dev server gives both one address (its
 * update stamp included) and each module is fetched and run once. Never imported by code: a
 * build has no such script and leaves this file out.
 */
import './App';
import './plugins/loader';
