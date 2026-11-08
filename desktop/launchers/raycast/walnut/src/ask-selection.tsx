/**
 * Quick Question About Selection: the text selected in the app you are in comes along; type what to
 * do with it (revise, translate, reply) and the quick answer is ready to paste back.
 */
import { getFrontmostApplication, getSelectedText, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { Conversation } from "./conversation";

export default function Command() {
  const [state, setState] = useState<{ selection?: string; app?: string; ready: boolean }>({ ready: false });

  useEffect(() => {
    void (async () => {
      const [selection, app] = await Promise.all([
        getSelectedText().catch(() => undefined),
        getFrontmostApplication().then((a) => a.name).catch(() => undefined),
      ]);
      setState({ selection: selection?.trim() || undefined, app, ready: true });
    })();
  }, []);

  if (!state.ready) return <List isLoading searchBarPlaceholder="Reading the selected text…" />;
  return <Conversation mode="quick" selection={state.selection} app={state.app} />;
}
