type NativeSignIn = { postMessage: (op: string) => Promise<unknown> };

function signInBridge(): NativeSignIn | undefined {
  return (window as unknown as { webkit?: { messageHandlers?: { walnutClaudeSignIn?: NativeSignIn } } }).webkit?.messageHandlers?.walnutClaudeSignIn;
}

export function canOpenClaudeSignIn(): boolean {
  return typeof window !== 'undefined' && !!signInBridge();
}

export async function openClaudeSignIn(): Promise<void> {
  const bridge = signInBridge();
  if (!bridge) throw new Error('Run claude in a terminal to sign in.');
  await bridge.postMessage('sign-in');
}
