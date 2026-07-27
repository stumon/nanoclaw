/**
 * 英文新闻标题译为简体中文（供 news-summary 等脚本使用）
 *
 * 优先级：
 * 1. 已像中文的标题：原样返回
 * 2. 设置 NEWS_SUMMARY_NO_TRANSLATE=1：不翻译
 * 3. OPENAI_API_KEY + OPENAI_BASE_URL：一次 LLM 批量翻译（质量最好）
 * 4. MyMemory 免费接口：逐条翻译（有配额，适合每日十几条）
 */

function looksMostlyChinese(s: string): boolean {
  const hanCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return hanCount >= 4 && hanCount >= s.replace(/\s/g, '').length * 0.35;
}

async function translateBatchOpenAI(titles: string[]): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  const base =
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!apiKey || titles.length === 0) throw new Error('no key');

  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'system' as const,
        content:
          '你是新闻编辑。将用户给出的 JSON 数组中的每条英文新闻标题翻译成简体中文，保持顺序与条数完全一致。只输出合法 JSON 数组字符串，不要 markdown、不要解释。',
      },
      {
        role: 'user' as const,
        content: JSON.stringify(titles),
      },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OpenAI ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, ''));
  if (!Array.isArray(parsed) || parsed.length !== titles.length) {
    throw new Error('LLM batch translate: bad array length');
  }
  return parsed.map((x) => String(x).trim());
}

async function translateOneMyMemory(text: string): Promise<string> {
  const q = encodeURIComponent(text.slice(0, 500));
  const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=en|zh-CN`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!res.ok) throw new Error(`MyMemory ${res.status}`);
  const data = (await res.json()) as {
    responseData?: { translatedText?: string };
    responseStatus?: number;
  };
  const out = data.responseData?.translatedText?.trim();
  if (!out) throw new Error('MyMemory empty');
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 将多条英文标题译为中文；已含足够汉字的条目会跳过翻译。
 */
export async function translateNewsTitlesToZh(titles: string[]): Promise<string[]> {
  if (process.env.NEWS_SUMMARY_NO_TRANSLATE === '1') {
    return titles;
  }

  const indices: number[] = [];
  const toTranslate: string[] = [];
  const out = [...titles];

  for (let i = 0; i < titles.length; i++) {
    const t = titles[i].trim();
    if (!t || looksMostlyChinese(t)) {
      out[i] = t;
    } else {
      indices.push(i);
      toTranslate.push(t);
    }
  }

  if (toTranslate.length === 0) return out;

  try {
    if (process.env.OPENAI_API_KEY) {
      const zh = await translateBatchOpenAI(toTranslate);
      for (let k = 0; k < indices.length; k++) {
        out[indices[k]] = zh[k] ?? toTranslate[k];
      }
      return out;
    }
  } catch (e) {
    console.warn('[translate] OpenAI batch failed, fallback MyMemory:', e);
  }

  for (let k = 0; k < indices.length; k++) {
    try {
      out[indices[k]] = await translateOneMyMemory(toTranslate[k]);
    } catch (e) {
      console.warn('[translate] MyMemory failed for one line:', e);
      out[indices[k]] = toTranslate[k];
    }
    if (k < indices.length - 1) await sleep(150);
  }

  return out;
}
