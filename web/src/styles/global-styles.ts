/**
 * The console's global stylesheets, loaded by main.tsx right after the app's own code (App, or a
 * pop-out's shell and view) and so linked after every stylesheet of theirs. When main.tsx imported
 * App statically these came last in the one bundle, after every component's styles, and the
 * cascade still depends on that: a global rule wins over a component rule just as specific.
 */
import './globals.css';
import './home-navigation.css';
import './overlay-glass.css';
import './fullscreen-tab.css';
