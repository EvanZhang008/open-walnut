import { fetchSessionVscodeUri } from '@/api/sessions';
import { log } from '@/utils/log';

export function navigateToVscode(uri: string): void {
  const hook = (window as Window & { __openVscodeUriForTest?: (value: string) => void })
    .__openVscodeUriForTest;
  if (hook) {
    hook(uri);
    return;
  }
  window.location.href = uri;
}

export async function openSessionInVscode(sessionId: string): Promise<void> {
  try {
    const uri = await fetchSessionVscodeUri(sessionId);
    navigateToVscode(uri);
  } catch (error) {
    log.error('session-vscode', 'open in VS Code failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
