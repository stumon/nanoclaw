/**
 * AI-powered scoring and filtering for intelligence items.
 * Uses OpenAI-compatible API (reads OPENAI_API_KEY + OPENAI_BASE_URL from env).
 * Batches items per category into a single LLM call for efficiency.
 */

import type { IntelItem } from './intel-fetcher.js';

export interface ScoredItem extends IntelItem {
  score: number;
  comment: string;
}

interface ScoringConfig {
  model: string;
  minScore: number;
  maxItemsPerCategory: number;
  userProfile: string;
}

const MAX_RETRIES = 3;
const CALL_TIMEOUT = 60_000;

/** LLM 完全失败时给原始条目的保底分（略高于常见 minScore=7 的阈值） */
const FALLBACK_SCORE = 7;
const FALLBACK_COMMENT = 'AI 评分不可用，保留原始条目（未打分）';

async function callLLM(
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/+$/, '');

  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.3,
          max_tokens: 4096,
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const snippet = body.replace(/\s+/g, ' ').slice(0, 160);
        throw new Error(`LLM API ${res.status}: ${snippet}`);
      }

      const data = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return data.choices[0]?.message?.content ?? '';
    } catch (err) {
      lastErr = err;
      if (attempt === MAX_RETRIES) break;
      const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      const reason = err instanceof Error ? err.message.slice(0, 100) : String(err);
      console.warn(
        `[intel-scorer] LLM attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${reason}), retrying in ${backoff}ms`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr ?? new Error('unreachable');
}

function buildPrompt(items: IntelItem[], userProfile: string): string {
  const itemList = items
    .map(
      (item, i) =>
        `${i + 1}. [${item.source}] ${item.title}${item.snippet ? ` — ${item.snippet}` : ''}`,
    )
    .join('\n');

  return `你是一位私人情报分析师。根据用户画像对以下信息条目打分（1-10分），并附一句话中文点评。

用户画像：${userProfile}

评分标准：
- 9-10分：重大突破、行业转折点、直接影响用户工作
- 7-8分：有价值的新信息、值得关注的趋势
- 5-6分：一般性新闻、已知信息的更新
- 1-4分：噪音、不相关、重复旧闻

待评分条目：
${itemList}

请严格按以下 JSON 数组格式输出，不要输出其他内容：
[{"index": 1, "score": 8, "comment": "一句话点评"}, ...]`;
}

function parseScores(
  raw: string,
  items: IntelItem[],
): Array<{ index: number; score: number; comment: string }> {
  // Extract JSON array from the response (may be wrapped in markdown code block)
  const jsonMatch = raw.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn('[intel-scorer] Failed to extract JSON from LLM response');
    return items.map((_, i) => ({
      index: i + 1,
      score: 5,
      comment: '评分解析失败',
    }));
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      index: number;
      score: number;
      comment: string;
    }>;
    return parsed;
  } catch {
    console.warn('[intel-scorer] JSON parse failed');
    return items.map((_, i) => ({
      index: i + 1,
      score: 5,
      comment: '评分解析失败',
    }));
  }
}

/**
 * Score items per category and filter by min_score.
 * Returns only items that pass the threshold, sorted by score descending.
 */
export async function scoreAndFilter(
  itemsByCategory: Record<string, IntelItem[]>,
  config: ScoringConfig,
): Promise<Record<string, ScoredItem[]>> {
  const result: Record<string, ScoredItem[]> = {};

  // Process categories in parallel (each is one LLM call)
  const entries = Object.entries(itemsByCategory).filter(
    ([, items]) => items.length > 0,
  );

  const settled = await Promise.allSettled(
    entries.map(async ([cat, items]) => {
      const prompt = buildPrompt(items, config.userProfile);
      try {
        const raw = await callLLM(
          [{ role: 'user', content: prompt }],
          config.model,
        );
        const scores = parseScores(raw, items);

        const scored: ScoredItem[] = [];
        for (const s of scores) {
          const item = items[s.index - 1];
          if (!item) continue;
          if (s.score >= config.minScore) {
            scored.push({ ...item, score: s.score, comment: s.comment });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        return { cat, items: scored.slice(0, config.maxItemsPerCategory) };
      } catch (err) {
        // LLM 彻底不可用（例如 403/超时）：降级为"保留原始条目、标记未打分"，
        // 这样当日用户至少能看到新闻列表，而不是整个类目被丢空。
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[intel-scorer] ${cat}: LLM unavailable after retries (${reason.slice(0, 120)}); falling back to unscored items`,
        );
        const fallback: ScoredItem[] = items
          .slice(0, config.maxItemsPerCategory)
          .map((item) => ({
            ...item,
            score: FALLBACK_SCORE,
            comment: FALLBACK_COMMENT,
          }));
        return { cat, items: fallback };
      }
    }),
  );

  for (const s of settled) {
    if (s.status === 'fulfilled') {
      result[s.value.cat] = s.value.items;
    } else {
      console.error('[intel-scorer] Category scoring failed:', s.reason);
    }
  }

  return result;
}

/**
 * Generate a one-line editorial insight from all scored items.
 * 若 LLM 不可用，降级为无点评提示（不抛错，保证 pipeline 末端产物可生成）。
 */
export async function generateInsight(
  scoredItems: Record<string, ScoredItem[]>,
  model: string,
): Promise<string> {
  const allItems = Object.values(scoredItems).flat();
  if (allItems.length === 0) return '今日暂无高分情报';

  const top = allItems
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((i) => `[${i.score}分] ${i.title}`)
    .join('\n');

  try {
    const raw = await callLLM(
      [
        {
          role: 'user',
          content: `基于今日最重要的几条情报，用一句话（不超过50字）总结今日最值得关注的趋势或事件：\n\n${top}`,
        },
      ],
      model,
    );
    return raw.trim().replace(/^["']|["']$/g, '');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[intel-scorer] insight generation failed (${reason.slice(0, 120)}), skipping`,
    );
    return '（AI 点评不可用，条目见下）';
  }
}
