/**
 * One conversation with Walnut: the list shows each question, the detail pane the answer as it
 * streams, and the search bar takes the next question (Enter sends it). On an answer: Enter pastes
 * it into the app you came from, Cmd+C copies it.
 *
 * Three ways to answer, the first two switched with Cmd+T at any turn:
 *   - Quick Answer: the model alone, about two seconds (POST /quick/ask).
 *   - Claude Code: a normal Claude Code session in Walnut, an Ask Walnut chat with everything the
 *     user's Claude Code has (POST /quick/session); Cmd+O opens it in Walnut.
 *   - Main: Walnut's main agent (Ask Walnut's "Tell Main and wait").
 * A switch carries over the turns the other side has not seen, so the thread is never lost.
 */
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { askQuick, askSession, Mode, NOT_RUNNING, openTaskLink, tellMain } from "./walnut";

interface Turn {
  id: number;
  question: string;
  answer: string;
  status: "streaming" | "done" | "error" | "held";
  activity?: string;
  seconds?: number;
  /** Which side answered it. */
  via: Mode;
}

function newConversation(): string {
  return `raycast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|connect/i.test(message) ? NOT_RUNNING : message;
}

const TITLE: Record<Mode, string> = { quick: "Quick Answer", session: "Claude Code", main: "Main" };

export function Conversation(props: { mode: Mode; first?: string; selection?: string; app?: string }) {
  const [mode, setMode] = useState<Mode>(props.mode);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  /** The task of Main, or of the session this conversation started. */
  const [taskId, setTaskId] = useState<string | undefined>(undefined);
  const conversation = useRef(newConversation());
  const abort = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  /** Turn ids each side has read (asked there, or carried over to it). */
  const seen = useRef<Record<Mode, Set<number>>>({ quick: new Set(), session: new Set(), main: new Set() });

  const update = (id: number, patch: Partial<Turn>) =>
    setTurns((all) => all.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const ask = useCallback(
    async (question: string, via: Mode = mode) => {
      const text = question.trim();
      if (!text) return;
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      const id = nextId.current++;
      const firstTurn = turns.length === 0;
      // The finished turns the other side answered and this one has not read, oldest first.
      const unseen = [...turns].reverse().filter((t) => t.status === "done" && t.via !== via && !seen.current[via].has(t.id));
      setTurns((all) => [{ id, question: text, answer: "", status: "streaming", via }, ...all]);
      setSelected(String(id));
      setInput("");
      for (const t of [...unseen, { id }]) seen.current[via].add(t.id);
      const notes = [
        props.selection && firstTurn ? `${props.app ? `Text selected in ${props.app}` : "Selected text"}:\n${props.selection}` : "",
        unseen.length ? `Earlier in this chat:\n${unseen.map((t) => `Q: ${t.question}\nA: ${t.answer}`).join("\n\n")}` : "",
      ].filter(Boolean);
      const started = Date.now();
      const done = (answer: string) =>
        update(id, { answer, status: "done", activity: undefined, seconds: (Date.now() - started) / 1000 });
      try {
        if (via === "quick") {
          const got = await askQuick(text, {
            conversation: conversation.current,
            context: notes.length ? notes.join("\n\n") : undefined,
            signal: controller.signal,
            onText: (answer) => update(id, { answer }),
          });
          update(id, { answer: got.text, status: "done", seconds: (got.durationMs ?? Date.now() - started) / 1000 });
          return;
        }
        const message = notes.length ? `${text}\n\n${notes.join("\n\n")}` : text;
        const follow = {
          signal: controller.signal,
          onSent: (sentTo: string) => setTaskId(sentTo),
          onProgress: (p: { text: string; activity?: string }) => update(id, { answer: p.text, activity: p.activity }),
        };
        const got = via === "main"
          ? await tellMain(message, follow)
          : await askSession(message, taskId, follow);
        setTaskId(got.taskId);
        if (got.held) {
          const who = via === "main" ? "Main is" : "The session is";
          update(id, { status: "held", answer: `${who} waiting for your answer to its question first, so nothing was sent. Open it in Walnut to answer.` });
          return;
        }
        const who = via === "main" ? "Main" : "The session";
        done(got.text || (got.unfinished
          ? `${who} is still working on it. Its reply will be in its chat in Walnut.`
          : `${who} finished without a written reply. Open it in Walnut to see what it did.`));
      } catch (error) {
        // A turn replaced by the next question keeps what it had, never a spinner forever.
        if (controller.signal.aborted) {
          setTurns((all) => all.map((t) => (t.id === id && t.status === "streaming" ? { ...t, status: t.answer ? "done" : "error", answer: t.answer || "Stopped." } : t)));
          return;
        }
        update(id, { status: "error", answer: failure(error) });
      }
    },
    [mode, taskId, props.app, props.selection, turns],
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

  const placeholder = turns.length === 0
    ? props.selection
      ? "What should Walnut do with the selected text?"
      : mode === "main" ? "Tell Main…" : mode === "session" ? "Ask Claude Code anything…" : "Ask anything…"
    : "Ask a follow-up, then Enter…";

  const detailFor = (t: Turn) => {
    const who = t.via === "main" ? "Main" : "Walnut";
    const head = t.status === "streaming" && !t.answer
      ? t.via === "quick"
        ? "_…_"
        : t.activity ? `_${who} is working: ${t.activity}…_` : `_${who} is reading it…_`
      : "";
    const body = t.status === "error" ? `⚠️ ${t.answer}` : t.answer;
    return `**${t.question}**\n\n${head}${body}`;
  };

  const switchMode = mode !== "main" ? (
    <Action
      title={mode === "quick" ? "Hand to Claude Code" : "Switch to Quick Answer"}
      icon={mode === "quick" ? Icon.Terminal : Icon.Bolt}
      shortcut={{ modifiers: ["cmd"], key: "t" }}
      onAction={() => setMode((m) => (m === "quick" ? "session" : "quick"))}
    />
  ) : null;
  const openInWalnut = taskId ? (
    <Action.Open
      title={mode === "main" ? "Open Main in Walnut" : "Open This Chat in Walnut"}
      target={openTaskLink(taskId)}
      icon={Icon.AppWindow}
      shortcut={{ modifiers: ["cmd"], key: "o" }}
    />
  ) : null;

  return (
    // Raycast filters a List by the search text unless told not to: a follow-up typed there hid
    // every earlier turn that did not contain its words (2026-10-31, "why can't it ask the follow
    // up"). The search bar here is only the next question.
    <List
      filtering={false}
      isShowingDetail={turns.length > 0}
      searchText={input}
      onSearchTextChange={setInput}
      searchBarPlaceholder={placeholder}
      navigationTitle={`Walnut · ${TITLE[mode]}`}
      selectedItemId={selected}
      onSelectionChange={(id) => setSelected(id ?? undefined)}
      isLoading={turns.some((t) => t.status === "streaming")}
    >
      {turns.length === 0 ? (
        <List.EmptyView
          icon={{ source: "walnut-icon.png" }}
          title={props.selection ? `Selected${props.app ? ` in ${props.app}` : ""}` : TITLE[mode]}
          description={props.selection ? `“${props.selection.slice(0, 200)}${props.selection.length > 200 ? "…" : ""}”\n\nType what to do with it, then press Enter.` : "Type, then press Enter."}
          actions={
            <ActionPanel>
              <Action title="Send" icon={Icon.ArrowRight} onAction={() => void ask(input)} />
              {switchMode}
            </ActionPanel>
          }
        />
      ) : (
        turns.map((t) => (
          <List.Item
            key={t.id}
            id={String(t.id)}
            title={t.question}
            icon={t.status === "streaming" ? Icon.CircleProgress : t.status === "error" ? Icon.Warning : t.via === "session" ? Icon.Terminal : Icon.Message}
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
                {t.status === "streaming" ? (
                  <Action title="Stop Waiting" icon={Icon.Stop} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={() => abort.current?.abort()} />
                ) : null}
                {openInWalnut}
                {t.status === "done" || t.status === "error" ? (
                  <Action title="Ask Again" icon={Icon.RotateClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => void ask(t.question, t.via)} />
                ) : null}
                {switchMode}
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
