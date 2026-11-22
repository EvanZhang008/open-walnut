/**
 * The console's global stylesheets, loaded by main.tsx right after the app's own code (App, or a
 * pop-out's shell and view) and so linked after every stylesheet of theirs. When main.tsx imported
 * App statically these came last in the one bundle, after every component's styles, and the
 * cascade still depends on that: a global rule wins over a component rule just as specific.
 */
import './buttons.css';
import './globals.css';
import './badge.css';
// After globals.css: a Working task's glyph breathes (task-working-pulse).
import './working-pulse.css';
import './chat-palette.css';
import './home-navigation.css';
import './overlay-glass.css';
import './overlay-family.css';
import './fullscreen-tab.css';
import './chat-reading.css';
import './text-fit.css';
// Last: the one input box look (input-box.css) wins over every rule above it of the same weight.
import './input-box.css';
