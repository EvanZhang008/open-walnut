/**
 * Google Generative AI protocol adapter.
 *
 * Uses the official `@google/generative-ai` SDK (v0.x) for Gemini models.
 * Translates between Walnut's Anthropic-style internal types and Google's format.
 */
import {
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type Part,
  type FunctionDeclaration,
  type GenerateContentResult,
  type EnhancedGenerateContentResponse,
  type GenerativeModel,
} from '@google/generative-ai';
import type {
  ApiProtocol, ProtocolAdapter, AdapterCallOptions, ModelResult,
  ContentBlock, MessageParam, Tool, UsageStats,
} from './types.js';
import { MAX_RETRIES, sleep, abortedResult } from './retry.js';
import { log } from '../../logging/index.js';

// ── Conversion helpers ──

/** Convert Anthropic system param to a string for systemInstruction. */
function buildSystemInstruction(system: AdapterCallOptions['system']): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  const text = system.map(b => b.text).join('\n');
  return text || undefined;
}

/** Convert Anthropic MessageParam[] to Google Content[]. */
function convertMessages(messages: MessageParam[]): Content[] {
  const result: Content[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', parts: [{ text: msg.content }] });
      } else {
        const parts: Part[] = [];
        for (const block of msg.content as any[]) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_result') {
            let responseData: Record<string, unknown>;
            if (typeof block.content === 'string') {
              responseData = { result: block.content };
            } else if (Array.isArray(block.content)) {
              responseData = { result: block.content.map((c: any) => c.text ?? JSON.stringify(c)).join('\n') };
            } else {
              responseData = { result: JSON.stringify(block.content ?? '') };
            }
            parts.push({
              functionResponse: {
                name: block.name ?? block.tool_use_id ?? 'unknown',
                response: responseData,
              },
            });
          } else if (block.type === 'image') {
            parts.push({ text: '[image]' });
          }
        }
        if (parts.length) result.push({ role: 'user', parts });
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'model', parts: [{ text: msg.content }] });
      } else {
        const parts: Part[] = [];
        for (const block of msg.content as any[]) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            const anyBlock = block as any;
            // Gemini 3+ returns thoughtSignature at the Part level (sibling to functionCall,
            // not inside it). It must be echoed back exactly for multi-turn tool calling to work.
            const fcPart: any = {
              functionCall: {
                name: anyBlock.name,
                args: anyBlock.input as Record<string, unknown>,
              },
            };
            if (anyBlock.id) fcPart.functionCall.id = anyBlock.id;
            if (anyBlock.thoughtSignature) fcPart.thoughtSignature = anyBlock.thoughtSignature;
            parts.push(fcPart);
          }
        }
        if (parts.length) result.push({ role: 'model', parts });
      }
    }
  }

  return result;
}

/** Convert Anthropic Tool[] to Google FunctionDeclaration[]. */
function convertToolDeclarations(tools?: Tool[]): FunctionDeclaration[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    parameters: convertJsonSchemaToGoogle(t.input_schema as Record<string, unknown>),
  }));
}

/** Convert JSON Schema to Google's Schema format (best effort). */
function convertJsonSchemaToGoogle(schema: Record<string, unknown>): any {
  if (!schema) return undefined;
  const result: Record<string, unknown> = {};

  if (schema.type) {
    const typeMap: Record<string, SchemaType> = {
      string: SchemaType.STRING,
      number: SchemaType.NUMBER,
      integer: SchemaType.INTEGER,
      boolean: SchemaType.BOOLEAN,
      array: SchemaType.ARRAY,
      object: SchemaType.OBJECT,
    };
    result.type = typeMap[schema.type as string] ?? SchemaType.STRING;
  }
  if (schema.description) result.description = schema.description;
  if (schema.enum) result.enum = schema.enum;
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(schema.properties as Record<string, unknown>)) {
      props[key] = convertJsonSchemaToGoogle(val as Record<string, unknown>);
    }
    result.properties = props;
  }
  if (schema.required) result.required = schema.required;
  if (schema.items) result.items = convertJsonSchemaToGoogle(schema.items as Record<string, unknown>);

  return result;
}

/** Convert Google response to Anthropic-style ContentBlock[]. */
function convertResponse(response: EnhancedGenerateContentResponse): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const candidate = response.candidates?.[0];
  if (!candidate?.content?.parts) return blocks;

  for (const part of candidate.content.parts) {
    if (part.text) {
      blocks.push({ type: 'text', text: part.text } as ContentBlock);
    }
    if (part.functionCall) {
      const fc: any = part.functionCall;
      const anyPart = part as any;
      const block: any = {
        type: 'tool_use',
        id: fc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: fc.name,
        input: (fc.args ?? {}) as Record<string, unknown>,
      };
      // Preserve thoughtSignature for Gemini 3+ (part-level, must echo back)
      if (anyPart.thoughtSignature) block.thoughtSignature = anyPart.thoughtSignature;
      blocks.push(block as ContentBlock);
    }
  }

  return blocks;
}

/** Map Google finish reason to Anthropic stop reason. */
function mapStopReason(candidate: any): string | null {
  if (!candidate?.finishReason) return null;
  switch (candidate.finishReason) {
    case 'STOP': return 'end_turn';
    case 'MAX_TOKENS': return 'max_tokens';
    case 'SAFETY': return 'end_turn';
    case 'RECITATION': return 'end_turn';
    default: return 'end_turn';
  }
}

/** Extract usage stats from Google response. */
function extractGoogleUsage(response: EnhancedGenerateContentResponse): UsageStats | undefined {
  const meta = response.usageMetadata;
  if (!meta) return undefined;
  return {
    input_tokens: meta.promptTokenCount,
    output_tokens: meta.candidatesTokenCount,
  };
}

// ── Retry helpers ──

function isRetryableGoogle(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return msg.includes('429') || msg.includes('503') || msg.includes('RESOURCE_EXHAUSTED');
}

// ── Adapter ──

export class GoogleAdapter implements ProtocolAdapter {
  readonly protocol: ApiProtocol = 'google-generative-ai';
  private genAI: GoogleGenerativeAI | null = null;
  private lastConfig: string | null = null;

  private getGenAI(apiKey?: string): GoogleGenerativeAI {
    const configKey = apiKey?.slice(-6) ?? '';
    if (this.genAI && this.lastConfig === configKey) return this.genAI;

    if (!apiKey) throw new Error('Google Generative AI requires an API key');
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.lastConfig = configKey;
    return this.genAI;
  }

  private getModel(opts: AdapterCallOptions): GenerativeModel {
    const genAI = this.getGenAI(opts.providerConfig.api_key);
    const systemInstruction = buildSystemInstruction(opts.system);
    const toolDecls = convertToolDeclarations(opts.tools);

    return genAI.getGenerativeModel({
      model: opts.model,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(toolDecls ? { tools: [{ functionDeclarations: toolDecls }] } : {}),
      generationConfig: {
        maxOutputTokens: opts.maxTokens,
      },
    });
  }

  resetClient(): void {
    this.genAI = null;
    this.lastConfig = null;
  }

  async sendMessage(opts: AdapterCallOptions): Promise<ModelResult> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const model = this.getModel(opts);
        const contents = convertMessages(opts.messages);

        const result: GenerateContentResult = await model.generateContent({ contents });
        const response = result.response;
        const candidate = response.candidates?.[0];

        return {
          content: convertResponse(response),
          stopReason: mapStopReason(candidate),
          usage: extractGoogleUsage(response),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult();
        if (isRetryableGoogle(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
          log.agent.warn(`google 429/5xx on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }

  async sendMessageStream(
    opts: AdapterCallOptions & { onTextDelta?: (delta: string) => void },
  ): Promise<ModelResult> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let accumulatedText = '';

      try {
        const model = this.getModel(opts);
        const contents = convertMessages(opts.messages);

        const result = await model.generateContentStream({ contents });

        // Collect all parts from the stream
        const toolBlocks: ContentBlock[] = [];

        for await (const chunk of result.stream) {
          const candidate = chunk.candidates?.[0];
          if (!candidate?.content?.parts) continue;

          for (const part of candidate.content.parts) {
            if (part.text) {
              accumulatedText += part.text;
              opts.onTextDelta?.(part.text);
            }
            if (part.functionCall) {
              const fc: any = part.functionCall;
              const anyPart = part as any;
              const block: any = {
                type: 'tool_use',
                id: fc.id ?? `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                name: fc.name,
                input: (fc.args ?? {}) as Record<string, unknown>,
              };
              if (anyPart.thoughtSignature) block.thoughtSignature = anyPart.thoughtSignature;
              toolBlocks.push(block as ContentBlock);
            }
          }
        }

        // Build final content
        const content: ContentBlock[] = [];
        if (accumulatedText) {
          content.push({ type: 'text', text: accumulatedText } as ContentBlock);
        }
        content.push(...toolBlocks);

        // Get aggregated response for usage metadata
        const aggregated = await result.response;
        const lastCandidate = aggregated.candidates?.[0];

        return {
          content,
          stopReason: mapStopReason(lastCandidate) ?? 'end_turn',
          usage: extractGoogleUsage(aggregated),
        };
      } catch (err) {
        if (opts.signal?.aborted) return abortedResult(accumulatedText);
        if (isRetryableGoogle(err) && attempt < MAX_RETRIES) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
          log.agent.warn(`google 429/5xx on stream attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying in ${Math.round(delay)}ms`);
          await sleep(delay, opts.signal);
          if (opts.signal?.aborted) return abortedResult();
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable: retry loop exhausted');
  }
}
