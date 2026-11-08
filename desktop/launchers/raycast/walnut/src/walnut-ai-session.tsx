/** Quick Question: a normal Claude Code session in Walnut from the start (see walnut-ai.tsx). */
import { LaunchProps } from "@raycast/api";
import { Conversation } from "./conversation";

export default function Command(props: LaunchProps) {
  const first = props.fallbackText?.trim() || props.launchContext?.text?.trim() || undefined;
  return <Conversation mode="session" first={first} />;
}
