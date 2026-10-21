/**
 * Ready-made triggers plugins offer (server: src/core/routines/trigger-templates.ts).
 * Arming one is an ordinary trigger create with `template` + `params`.
 */
import { ApiError, apiGet, apiPost } from './client';

export interface TriggerTemplateParam {
  key: string;
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
  options?: boolean;
}

export interface TriggerTemplate {
  id: string;
  pluginId: string;
  pluginName: string;
  title: string;
  description: string;
  params: TriggerTemplateParam[];
  every: string;
  maxFiresPerDay?: number;
  examples?: string[];
}

export interface TriggerTemplateOption {
  value: string;
  label: string;
  hint?: string;
}

export interface CreatedTemplateTrigger {
  id: string;
  name: string;
  description: string;
  everyMs: number;
}

export async function fetchTriggerTemplates(): Promise<TriggerTemplate[]> {
  const res = await apiGet<{ templates?: TriggerTemplate[] }>('/api/v1/trigger-templates', undefined, { timeoutMs: 8000 });
  return Array.isArray(res.templates) ? res.templates : [];
}

export async function fetchTriggerTemplateOptions(template: string, param: string, q: string): Promise<TriggerTemplateOption[]> {
  const res = await apiGet<{ options?: TriggerTemplateOption[] }>(
    `/api/v1/trigger-templates/${encodeURIComponent(template)}/options`,
    { param, q },
    { timeoutMs: 15000 },
  );
  return Array.isArray(res.options) ? res.options : [];
}

/** The server's own sentence for a refused create ("No channel #foo"), else the status text. */
export function triggerErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: { message?: string } | string; message?: string } | undefined;
    const message = typeof body?.error === 'object' ? body.error?.message : typeof body?.error === 'string' ? body.error : body?.message;
    return message || err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function createTemplateTrigger(input: {
  template: string;
  params: Record<string, string>;
  taskId: string;
  every?: string;
  prompt?: string;
}): Promise<CreatedTemplateTrigger> {
  const res = await apiPost<{ job?: { id?: string; name?: string; description?: string; schedule?: { everyMs?: number } } }>(
    '/api/v1/routines/trigger',
    {
      template: input.template,
      params: input.params,
      session: input.taskId,
      // A trigger made from the composer leaves the task where it is: the user is right here.
      wait: false,
      ...(input.every ? { every: input.every } : {}),
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
    },
    { timeoutMs: 30000 },
  );
  return {
    id: res.job?.id ?? '',
    name: res.job?.name ?? '',
    description: res.job?.description ?? '',
    everyMs: res.job?.schedule?.everyMs ?? 0,
  };
}
