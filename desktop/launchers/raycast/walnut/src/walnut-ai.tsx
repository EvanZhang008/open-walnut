/**
 * Walnut AI: type anything in Raycast's root search and send it here (set this command as a
 * fallback command), or open it and type. Quick answers come from the model alone; Cmd+T switches
 * to With tools, a light agent session that may search the web and read pages.
 */
import { LaunchProps } from "@raycast/api";
import { Conversation } from "./conversation";

export default function Command(props: LaunchProps) {
  const first = props.fallbackText?.trim() || props.launchContext?.text?.trim() || undefined;
  return <Conversation mode="quick" first={first} />;
}
