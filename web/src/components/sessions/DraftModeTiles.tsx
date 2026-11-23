/**
 * The new task draft's two modes as square tiles (experiment `project_first_start`, v6): two tabs,
 * two different conversations.
 *
 *   [ >_  Start task / A coding session ]   [ (Walnut)  Quick chat / Ask Walnut, no task ]
 *
 * The shared tabs' tile variant (TabList tiles, choice-controls.css): the chosen one has the
 * accent border and fill, no check (a pick is shown by colour); the other is grey (its icon too). Both keep
 * the same border width, so a switch moves nothing; arrows move between them as in every tab strip. Quick chat puts its
 * one block (QuickChatBlock) where the Project + Where row stands, at the same height.
 */
import * as ICONS from '@/components/common/Icons';
import { WalnutIcon } from '@/components/common/WalnutIcon';
import { Tab, TabList } from '@/components/controls';

export function DraftModeTiles({ walnut, onPick }: { walnut: boolean; onPick: (walnut: boolean) => void }) {
  const tile = (isWalnut: boolean) => {
    const on = walnut === isWalnut;
    return (
      <Tab
        key={isWalnut ? 'chat' : 'task'}
        selected={on}
        className="draft-v6-tile"
        data-mode-card={isWalnut ? 'chat' : 'task'}
        title={isWalnut ? 'Quick chat: a question for Walnut, no task is made' : 'Start task: a coding session in a project or a folder'}
        // The composer keeps its caret (WebKit blurs a textarea on a button press).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { if (!on) onPick(isWalnut); }}
      >
        <span className={`draft-v6-tile-icon${isWalnut ? ' is-walnut' : ' is-term'}`} aria-hidden="true">
          {isWalnut ? <WalnutIcon size={58} className="draft-v6-tile-walnut" /> : ICONS.ICON_TERMINAL}
        </span>
        <span className="draft-v6-tile-title">{isWalnut ? 'Quick chat' : 'Start task'}</span>
        <span className="draft-v6-tile-line">{isWalnut ? 'Ask Walnut, no task' : 'A coding session'}</span>
      </Tab>
    );
  };
  return (
    <TabList tiles className="draft-v6-tiles" aria-label="What this draft starts">
      {tile(false)}
      {tile(true)}
    </TabList>
  );
}

/** Quick chat's block in the row's place: what it does, left aligned, no frame. Another console
 *  agent's draft names that agent instead. */
export function QuickChatBlock({ title = 'Ask Walnut.', line = 'Answers from your tasks and notes. Nothing runs in a folder.' }: { title?: string; line?: string }) {
  return (
    <div className="draft-v6-quick" data-testid="draft-v6-quick">
      <WalnutIcon size={36} className="draft-v6-quick-icon" />
      <span className="draft-v6-quick-text">
        <b className="draft-v6-quick-title">{title}</b>
        <small className="draft-v6-quick-line">{line}</small>
      </span>
    </div>
  );
}
