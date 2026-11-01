/** Walnut AI with tools from the start: web search and page reading (see walnut-ai.tsx). */
import { LaunchProps } from "@raycast/api";
import { Conversation } from "./conversation";

export default function Command(props: LaunchProps) {
  const first = props.fallbackText?.trim() || props.launchContext?.text?.trim() || undefined;
  return <Conversation mode="quick" tools first={first} />;
}
