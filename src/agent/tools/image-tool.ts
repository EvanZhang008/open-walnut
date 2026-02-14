/**
 * Image analysis tool using the existing Bedrock Claude vision API.
 * Reads an image file, encodes it as base64, and sends it to Claude for analysis.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../tools.js';
import { log } from '../../logging/index.js';
import { usageTracker } from '../../core/usage/index.js';
import { DEFAULT_MODEL } from '../model.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const imageTool: ToolDefinition = {
  name: 'analyze_image',
  description:
    'Analyze an image file using Claude vision. Supports PNG, JPEG, GIF, and WebP formats.',
  input_schema: {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Absolute path to the image file',
      },
      prompt: {
        type: 'string',
        description:
          'What to analyze or describe about the image (default: "Describe this image in detail")',
      },
    },
    required: ['image_path'],
  },
  async execute(params) {
    const imagePath = params.image_path as string;
    const prompt = (params.prompt as string) || 'Describe this image in detail';

    if (!fs.existsSync(imagePath)) {
      return `Error: File not found — ${imagePath}`;
    }

    const ext = path.extname(imagePath).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) {
      return `Error: Unsupported image format "${ext}". Supported: ${Object.keys(MIME_TYPES).join(', ')}`;
    }

    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');

      const { sendMessage } = await import('../model.js');
      const response = await sendMessage({
        system: 'You are an image analysis assistant. Provide clear, accurate descriptions.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64,
                },
              } as unknown as import('@anthropic-ai/sdk/resources/messages').ContentBlockParam,
              { type: 'text', text: prompt },
            ],
          },
        ],
      });

      // Record usage
      if (response.usage) {
        try { usageTracker.record({
          source: 'image-tool',
          model: DEFAULT_MODEL,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
        }); } catch {}
      }

      const textBlocks = response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text);

      const analysis = textBlocks.join('\n\n');
      log.agent.info('image analyzed', { imagePath, promptLength: prompt.length });
      return analysis || 'No analysis returned.';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent.error('image analysis error', { imagePath, error: msg });
      return `Error: Image analysis failed — ${msg}`;
    }
  },
};
