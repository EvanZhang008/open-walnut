/**
 * Ask Walnut: type, then Enter to tell Main (sent, and Raycast closes: the reply is in Main's chat)
 * or Cmd+Enter for a quick answer here; the tasks matching the words list below, and Enter on one
 * opens it in Walnut.
 */
import { Action, ActionPanel, Icon, List, open, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { Conversation } from "./conversation";
import { findTasks, NOT_RUNNING, openTaskLink, QuickTask, sendToMain } from "./walnut";

/** Fire and forget: the message goes into Main's chat and the window closes. */
async function tellMainAndGo(text: string): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to Main…" });
  try {
    const got = await sendToMain(text);
    if (got.held) {
      toast.style = Toast.Style.Failure;
      toast.title = "Not sent: Main is waiting for your answer";
      toast.message = "Answer its question in Walnut first.";
      if (got.taskId) toast.primaryAction = { title: "Open Main", onAction: () => void open(openTaskLink(got.taskId)) };
      return;
    }
    await showHUD("Sent to Main");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.style = Toast.Style.Failure;
    toast.title = "Main did not get it";
    toast.message = /fetch failed|ECONNREFUSED|connect/i.test(message) ? NOT_RUNNING : message;
  }
}

const STATE_COLOR: Record<string, string> = { needs: "#FF9F0A", working: "#0A84FF", waiting: "#8E8E93", done: "#34C759" };

export default function Command() {
  const [text, setText] = useState("");
  const [tasks, setTasks] = useState<QuickTask[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setTasks([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      findTasks(q, controller.signal)
        .then(setTasks, () => setTasks([]))
        .finally(() => setLoading(false));
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text]);

  const q = text.trim();
  return (
    <List
      searchText={text}
      onSearchTextChange={setText}
      searchBarPlaceholder="Ask anything, revise a text, find a task…"
      filtering={false}
      isLoading={loading}
    >
      {q ? (
        <List.Section title="Ask">
          <List.Item
            id="main"
            icon={Icon.Person}
            title={q}
            subtitle="Tell Main: sends it to Main's chat"
            accessories={[{ text: "↵" }]}
            actions={
              <ActionPanel>
                <Action title="Tell Main" icon={Icon.Person} onAction={() => void tellMainAndGo(q)} />
                <Action.Push
                  title="Quick Answer"
                  icon={Icon.Bolt}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                  target={<Conversation mode="quick" first={q} />}
                />
                <Action.Push
                  title="Tell Main and Wait for the Reply"
                  icon={Icon.Message}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "return" }}
                  target={<Conversation mode="main" first={q} />}
                />
              </ActionPanel>
            }
          />
          <List.Item
            id="quick"
            icon={Icon.Bolt}
            title={q}
            subtitle="Quick answer"
            accessories={[{ text: "⌘↵" }]}
            actions={
              <ActionPanel>
                <Action.Push title="Quick Answer" icon={Icon.Bolt} target={<Conversation mode="quick" first={q} />} />
              </ActionPanel>
            }
          />
        </List.Section>
      ) : (
        <List.EmptyView icon={{ source: "walnut-icon.png" }} title="Ask Walnut" description="Type a question, a text to revise, or words of a task to find." />
      )}
      {tasks.length > 0 ? (
        <List.Section title="Tasks">
          {tasks.map((t) => (
            <List.Item
              key={t.id}
              id={`task-${t.id}`}
              icon={{ source: Icon.CircleFilled, tintColor: STATE_COLOR[t.state] ?? "#8E8E93" }}
              title={t.title}
              subtitle={t.project}
              accessories={[{ text: t.stateLabel }]}
              actions={
                <ActionPanel>
                  <Action.Open title="Open in Walnut" icon={Icon.AppWindow} target={openTaskLink(t.id)} />
                  <Action.CopyToClipboard title="Copy Title" content={t.title} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
