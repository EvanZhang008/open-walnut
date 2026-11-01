/**
 * A message straight into one task's chat, from the task found in Ask Walnut: type it, Cmd+Enter
 * sends it and Raycast closes (the task's reply is in Walnut). A task with no session is started
 * with it. A screenshot on the clipboard is offered as a checkbox, ticked, and goes with it.
 */
import { Action, ActionPanel, Form, Icon, open, showHUD, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { clipboardHasImage, readClipboardImage } from "./clipboard-image";
import { NOT_RUNNING, openTaskLink, QuickTask, sendToTask } from "./walnut";

export function TaskMessage(props: { task: QuickTask }) {
  const { task } = props;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [attach, setAttach] = useState(true);

  useEffect(() => {
    void clipboardHasImage().then(setHasImage);
  }, []);

  async function send() {
    const message = text.trim();
    const withImage = hasImage && attach;
    if ((!message && !withImage) || sending) return;
    setSending(true);
    const toast = await showToast({ style: Toast.Style.Animated, title: `Sending to “${task.title}”…` });
    try {
      const image = withImage ? await readClipboardImage() : null;
      if (withImage && !image) {
        toast.style = Toast.Style.Failure;
        toast.title = "The screenshot could not be read";
        toast.message = "Untick it to send the words alone, or copy it again.";
        return;
      }
      const got = await sendToTask(task.id, message, image ? [image] : undefined);
      if (got.held) {
        toast.style = Toast.Style.Failure;
        toast.title = "Not sent: the task is waiting for your answer";
        toast.message = "Answer its question in Walnut first.";
        toast.primaryAction = { title: "Open in Walnut", onAction: () => void open(openTaskLink(task.id)) };
        return;
      }
      await showHUD(got.started ? `Started “${task.title}” with it` : `Sent to “${task.title}”`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.style = Toast.Style.Failure;
      toast.title = "The task did not get it";
      toast.message = /fetch failed|ECONNREFUSED|connect/i.test(reason) ? NOT_RUNNING : reason;
    } finally {
      setSending(false);
    }
  }

  return (
    <Form
      navigationTitle={`Message · ${task.title}`}
      isLoading={sending}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Send to Task" icon={Icon.Message} onSubmit={() => void send()} />
          <Action.Open title="Open in Walnut" icon={Icon.AppWindow} target={openTaskLink(task.id)} shortcut={{ modifiers: ["cmd"], key: "o" }} />
        </ActionPanel>
      }
    >
      <Form.Description title="Task" text={`${task.title}${task.project ? ` · ${task.project}` : ""} · ${task.stateLabel}`} />
      <Form.TextArea id="message" title="Message" placeholder="Goes into the task's chat as your message" value={text} onChange={setText} autoFocus />
      {hasImage ? (
        <Form.Checkbox id="screenshot" label="Attach the copied screenshot" value={attach} onChange={setAttach} />
      ) : null}
    </Form>
  );
}
