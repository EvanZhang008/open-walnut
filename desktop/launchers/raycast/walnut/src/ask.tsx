/**
 * Ask Walnut: type, then Enter to tell Main (sent, and Raycast closes: the reply is in Main's chat)
 * or Cmd+Enter for a quick answer here. The tasks and notes matching the words list below: Enter
 * opens one in Walnut, Cmd+Enter on a task writes a message straight into its chat.
 */
import { Action, ActionPanel, Icon, List, open, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { Conversation } from "./conversation";
import { clipboardHasImage, readClipboardImage } from "./clipboard-image";
import { TaskMessage } from "./task-message";
import { findNotes, findTasks, NOT_RUNNING, openNoteLink, openTaskLink, QuickNote, QuickTask, sendToMain } from "./walnut";

/** Fire and forget: the message goes into Main's chat and the window closes. */
async function tellMainAndGo(text: string, withScreenshot = false): Promise<void> {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Sending to Main…" });
  try {
    const image = withScreenshot ? await readClipboardImage() : null;
    if (withScreenshot && !image) {
      toast.style = Toast.Style.Failure;
      toast.title = "No picture on the clipboard";
      toast.message = "Copy a screenshot (Ctrl+Shift+Cmd+4), then try again.";
      return;
    }
    const got = await sendToMain(text, image ? [image] : undefined);
    if (got.held) {
      toast.style = Toast.Style.Failure;
      toast.title = "Not sent: Main is waiting for your answer";
      toast.message = "Answer its question in Walnut first.";
      if (got.taskId) toast.primaryAction = { title: "Open Main", onAction: () => void open(openTaskLink(got.taskId)) };
      return;
    }
    await showHUD(image ? "Sent to Main with the screenshot" : "Sent to Main");
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
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [loading, setLoading] = useState(false);
  // A picture on the clipboard when Raycast opened: offered as its own row, never sent unasked.
  const [hasImage, setHasImage] = useState(false);

  useEffect(() => {
    void clipboardHasImage().then(setHasImage);
  }, []);

  useEffect(() => {
    const q = text.trim();
    if (!q) {
      setTasks([]);
      setNotes([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      // Each list shows as soon as it answers; neither waits for the other.
      void Promise.allSettled([
        findTasks(q, controller.signal).then(setTasks, () => setTasks([])),
        findNotes(q, controller.signal).then(setNotes, () => setNotes([])),
      ]).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
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
      {q || hasImage ? (
        <List.Section title="Ask">
          {q ? (
          <>
          <List.Item
            id="main"
            icon={Icon.Person}
            title={q}
            subtitle="Tell Main: sends it to Main's chat"
            accessories={[{ text: "↵" }]}
            actions={
              <ActionPanel>
                <Action title="Tell Main" icon={Icon.Person} onAction={() => void tellMainAndGo(q)} />
                {hasImage ? (
                  <Action
                    title="Tell Main with Screenshot"
                    icon={Icon.Image}
                    shortcut={{ modifiers: ["opt"], key: "return" }}
                    onAction={() => void tellMainAndGo(q, true)}
                  />
                ) : null}
                <Action.Push
                  title="Quick Answer"
                  icon={Icon.Bolt}
                  shortcut={{ modifiers: ["cmd"], key: "return" }}
                  target={<Conversation mode="quick" first={q} />}
                />
                <Action.Push
                  title="Ask Claude Code"
                  icon={Icon.Terminal}
                  shortcut={{ modifiers: ["cmd", "opt"], key: "return" }}
                  target={<Conversation mode="session" first={q} />}
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
          <List.Item
            id="session"
            icon={Icon.Terminal}
            title={q}
            subtitle="A Claude Code session in Walnut"
            accessories={[{ text: "⌘⌥↵" }]}
            actions={
              <ActionPanel>
                <Action.Push title="Ask Claude Code" icon={Icon.Terminal} target={<Conversation mode="session" first={q} />} />
              </ActionPanel>
            }
          />
          </>
          ) : null}
          {hasImage ? (
            <List.Item
              id="main-screenshot"
              icon={Icon.Image}
              title={q || "The copied screenshot"}
              subtitle="Tell Main with the copied screenshot"
              accessories={[{ text: "⌥↵" }]}
              actions={
                <ActionPanel>
                  <Action title="Tell Main with Screenshot" icon={Icon.Image} onAction={() => void tellMainAndGo(q, true)} />
                </ActionPanel>
              }
            />
          ) : null}
        </List.Section>
      ) : (
        <List.EmptyView icon={{ source: "walnut-icon.png" }} title="Ask Walnut" description="Type a question, a text to revise, or words of a task or note to find." />
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
                  <Action.Push
                    title="Message This Task"
                    icon={Icon.Message}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                    target={<TaskMessage task={t} />}
                  />
                  <Action.CopyToClipboard title="Copy Title" content={t.title} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
      {notes.length > 0 ? (
        <List.Section title="Notes">
          {notes.map((n) => (
            <List.Item
              key={n.path}
              id={`note-${n.path}`}
              icon={Icon.Document}
              title={n.title}
              subtitle={n.snippet.slice(0, 90)}
              accessories={[{ text: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : "" }]}
              actions={
                <ActionPanel>
                  <Action.Open title="Open in Walnut" icon={Icon.AppWindow} target={openNoteLink(n.path)} />
                  <Action.CopyToClipboard title="Copy Path" content={n.path} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
    </List>
  );
}
