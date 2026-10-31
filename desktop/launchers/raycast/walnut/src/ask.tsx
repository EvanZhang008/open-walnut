/**
 * Ask Walnut: type, then Enter for a quick answer or Cmd+Enter to tell Main; the tasks matching
 * the words list below, and Enter on one opens it in Walnut.
 */
import { Action, ActionPanel, Icon, List } from "@raycast/api";
import { useEffect, useState } from "react";
import { Conversation } from "./conversation";
import { findTasks, openTaskLink, QuickTask } from "./walnut";

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
            id="quick"
            icon={Icon.Bolt}
            title={q}
            subtitle="Quick answer"
            accessories={[{ text: "↵" }]}
            actions={
              <ActionPanel>
                <Action.Push title="Quick Answer" icon={Icon.Bolt} target={<Conversation mode="quick" first={q} />} />
                <Action.Push
                  title="Tell Main"
                  icon={Icon.Person}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                  target={<Conversation mode="main" first={q} />}
                />
              </ActionPanel>
            }
          />
          <List.Item
            id="main"
            icon={Icon.Person}
            title={q}
            subtitle="Tell Main: goes to Main's chat, its reply shows here"
            accessories={[{ text: "⌘↵" }]}
            actions={
              <ActionPanel>
                <Action.Push title="Tell Main" icon={Icon.Person} target={<Conversation mode="main" first={q} />} />
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
