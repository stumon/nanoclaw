/**
 * Host-side image preprocessing using a dedicated vision model.
 *
 * Replaces [Image: media/xxx.jpg] tags in message text with VL model
 * analysis results BEFORE the text reaches the container. This avoids
 * routing large base64 payloads through the container network proxy.
 */
import fs from 'fs';
import path from 'path';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const IMAGE_TAG_RE = /\[Image:\s*([^\]]+)\]/g;

let cachedConfig: {
  apiKey: string;
  baseURL: string;
  model: string;
} | null = null;

function getConfig(): typeof cachedConfig {
  if (cachedConfig) return cachedConfig;
  const env = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'VISION_MODEL',
  ]);
  if (!env.VISION_MODEL || !env.OPENAI_API_KEY || !env.OPENAI_BASE_URL) {
    return null;
  }
  cachedConfig = {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.VISION_MODEL,
  };
  return cachedConfig;
}

async function callVisionModel(
  config: NonNullable<ReturnType<typeof getConfig>>,
  base64: string,
  mime: string,
): Promise<string> {
  const url = `${config.baseURL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '请详细分析这张金融/券商APP截图。列出所有可见的持仓信息，包括：平台名称、每只股票/基金的名称、持仓数量、当前价格/市值、现金余额。用结构化格式输出，尽量精确。',
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mime};base64,${base64}` },
              },
            ],
          },
        ],
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return `[Vision API error: HTTP ${res.status} ${text.slice(0, 200)}]`;
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return (
      data.choices?.[0]?.message?.content || '[Vision model returned empty]'
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[Vision analysis failed: ${msg}]`;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Replace [Image: media/xxx.jpg] tags with VL model analysis text.
 * @param text      Message text potentially containing image tags
 * @param groupDir  Absolute path to the group folder on the host
 * @returns         Preprocessed text with image tags replaced by analysis
 */
export async function preprocessImageTags(
  text: string,
  groupDir: string,
): Promise<string> {
  const matches = [...text.matchAll(IMAGE_TAG_RE)];
  if (matches.length === 0) return text;

  const config = getConfig();
  if (!config) return text;

  logger.info(
    { imageCount: matches.length, model: config.model },
    'Preprocessing images with vision model (host-side)',
  );

  let result = text;
  for (const match of matches) {
    const relativePath = match[1].trim();
    const absPath = path.resolve(groupDir, relativePath);
    const rel = path.relative(groupDir, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      logger.warn({ relativePath }, 'Path traversal blocked');
      continue;
    }

    let buf: Buffer;
    try {
      buf = fs.readFileSync(absPath);
    } catch {
      logger.warn({ path: absPath }, 'Image file not found for preprocessing');
      result = result.replace(match[0], `[Image not found: ${relativePath}]`);
      continue;
    }

    const ext = path.extname(absPath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mime = mimeMap[ext] || 'image/jpeg';
    const base64 = buf.toString('base64');

    logger.info(
      { image: relativePath, size: buf.length },
      'Analyzing image with vision model',
    );

    const analysis = await callVisionModel(config, base64, mime);

    result = result.replace(
      match[0],
      `[Screenshot Analysis - ${relativePath}]:\n${analysis}\n[End Analysis]`,
    );

    logger.info(
      { image: relativePath, analysisLength: analysis.length },
      'Vision analysis complete',
    );
  }

  return result;
}
