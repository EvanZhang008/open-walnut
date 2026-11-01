/**
 * One conversation with Walnut, a quick answer or Main: the list shows each question, the detail
 * pane the answer as it streams, and the search bar takes the next question (Enter sends it).
 * On an answer: Enter pastes it into the app you came from, Cmd+C copies it.
 */
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { askQuick, Mode, NOT_RUNNING, openTaskLink, tellMain } from "./walnut";

interface Turn {
  id: number;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error" | "held";
  activity?: string;
  seconds?: number;
}

function newConversation(): string {
  return `raycast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|connect/i.test(message) ? NOT_RUNNING : message;
}

export function Conversation(props: { mode: Mode; first?: string; selection?: string; app?: string }) {
  const [mode] = useState<Mode>(props.mode);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [mainTaskId, setMainTaskId] = useState<string | undefined>(undefined);
  const conversation = useRef(newConversation());
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const update = (id: number, patch: Partial<Turn>) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const id = nextId.current++;
      const firstTurn = turns.length === 0;
      setTurns((all) => [{ id, question: text, answer: "", status: "streaming" }, ...all]);
      setSelected(String(id));
      setInput("");
      const selectionNote = props.selection && firstTurn
        ? `${props.app ? `Text selected in ${props.app}` : "Selected text"}:\n${props.selection}`
        : undefined;
      const started = Date.now();
      try {
        if (mode === "quick") {
          const got = await askQuick(text, {
            conversation: conversation.current,
            context: selectionNote,
            signal: controller.signal,
            onText: (answer) => update(id, { answer }),
          });
          update(id, { answer: got.text, status: "done", seconds: (got.durationMs ?? Date.now() - started) / 1000 });
        } else {
          const got = await tellMain(selectionNote ? `${text}\n\n${selectionNote}` : text, {
            signal: controller.signal,
            onSent: (taskId) => setMainTaskId(taskId),
            onProgress: (p) => update(id, { answer: p.text, activity: p.activity }),
          });
          setMainTaskId(got.taskId);
          if (got.held) {
            update(id, { status: "held", answer: "Main is waiting for your answer to its question first, so nothing was sent. Open Main to answer it." });
          } else {
            const answer = got.text || (got.unfinished
              ? "Main is still working on it. Its reply will be in Main's chat."
              : "Main finished without a written reply. Open Main to see what it did.");
            update(id, { answer, status: "done", activity: undefined });
          }
        }
      } catch (error) {
        // A turn replaced by the next question keeps what it had, never a spinner forever.
        if (controller.signal.aborted) {
          setTurns((all) => all.map((t) => (t.id === id && t.status === "streaming" ? { ...t, status: t.answer ? "done" : "error", answer: t.answer || "Stopped." } : t)));
          return;
        }
        update(id, { status: "error", answer: failure(error) });
      }
    },
    [mode, props.app, props.selection, turns.length],
  );

  // The first question is asked from a timer the effect's cleanup cancels: React may mount, unmount
  // and mount again (development mode, which `ray develop` runs), and an ask started in the first
  // mount was aborted by the second's cleanup and never asked again (2026-10-31: stuck on "…").
  const first = useRef(props.first);
  const askRef = useRef(ask);
  askRef.current = ask;
  useEffect(() => {
    const text = first.current;
    if (!text) return;
    const timer = setTimeout(() => {
      first.current = undefined;
      void askRef.current(text);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  const title = mode === "quick" ? "Quick answer" : "Main";
  const placeholder = turns.length === 0
    ? props.selection
      ? "What should Walnut do with the selected text?"
      : mode === "quick" ? "Ask anything…" : "Tell Main…"
    : "Ask a follow-up…";

  const detailFor = (t: Turn) => {
    const head = t.status === "streaming"
      ? (t.answer ? "" : mode === "main" ? (t.activity ? `_Main is working: ${t.activity}…_` : "_Main is reading it…_") : "_…_")
      : "";
    const status = t.status === "error" ? `⚠️ ${t.answer}` : t.answer;
    return `**${t.question}**\n\n${head}${status}`;
  };

  return (
    <List
      isShowingDetail={turns.length > 0}
      searchText={input}
      onSearchTextChange={setInput}
      searchBarPlaceholder={placeholder}
      navigationTitle={`Walnut · ${title}`}
      selectedItemId={selected}
      onSelectionChange={(id) => setSelected(id ?? undefined)}
      isLoading={turns.some((t) => t.status === "streaming")}
    >
      {turns.length === 0 ? (
        <List.EmptyView
          icon={{ source: "walnut-icon.png" }}
          title={props.selection ? `Selected${props.app ? ` in ${props.app}` : ""}` : title}
          description={props.selection ? `“${props.selection.slice(0, 200)}${props.selection.length > 200 ? "…" : ""}”\n\nType what to do with it, then press Enter.` : "Type, then press Enter."}
          actions={
            <ActionPanel>
              <Action title="Send" icon={Icon.ArrowRight} onAction={() => void ask(input)} />
            </ActionPanel>
          }
        />
      ) : (
        turns.map((t) => (
          <List.Item
            key={t.id}
            id={String(t.id)}
            title={t.question}
            icon={t.status === "streaming" ? Icon.CircleProgress : t.status === "error" ? Icon.Warning : Icon.Message}
            accessories={t.seconds ? [{ text: `${t.seconds.toFixed(1)} s` }] : []}
            detail={<List.Item.Detail markdown={detailFor(t)} />}
            actions={
              <ActionPanel>
                {input.trim() ? (
                  <Action title="Ask Follow-up" icon={Icon.ArrowRight} onAction={() => void ask(input)} />
                ) : null}
                {t.answer && t.status === "done" ? (
                  <>
                    <Action.Paste title="Paste Answer" content={t.answer} />
                    <Action.CopyToClipboard title="Copy Answer" content={t.answer} shortcut={{ modifiers: ["cmd"], key: "c" }} />
                  </>
                ) : null}
                {mode === "main" && mainTaskId ? (
                  <Action.Open title="Open Main in Walnut" target={openTaskLink(mainTaskId)} icon={Icon.AppWindow} shortcut={{ modifiers: ["cmd"], key: "o" }} />
                ) : null}
                {t.status === "done" || t.status === "error" ? (
                  <Action title="Ask Again" icon={Icon.RotateClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => void ask(t.question)} />
                ) : null}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
