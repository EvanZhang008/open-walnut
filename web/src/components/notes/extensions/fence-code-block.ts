/**
 * CodeBlock whose ``` shortcut fires on the THIRD BACKTICK.
 *
 * The stock rule (`^```([a-z]+)?[\s\n]$`) waits for a space or Enter after the
 * fence, so typing ``` visibly does nothing — the editor looks like it has no
 * code-block shortcut at all (user report, 2026-09-08). Notion and Slack convert
 * the moment the third backtick lands, and that is what people's fingers expect.
 *
 * Trade-off (same as Notion): a language tag can no longer be TYPED after the
 * fence, because the block already exists by the time "ts" would follow; the
 * stock ```lang␠ rule stays registered behind ours but is unreachable by typing
 * (input rules never see pastes). The `~~~lang␠` form still sets a language.
 * Backspace in the fresh empty block returns to a plain paragraph (CodeBlock's
 * own Backspace handler runs before undoInputRule); ⌘Z restores the typed text.
 */

import CodeBlock from '@tiptap/extension-code-block';
import { textblockTypeInputRule } from '@tiptap/core';

export const FenceCodeBlock = CodeBlock.extend({
  addInputRules() {
    return [
      textblockTypeInputRule({ find: /^```$/, type: this.type }),
      ...(this.parent?.() ?? []),
    ];
  },
});
