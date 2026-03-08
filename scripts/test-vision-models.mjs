import fs from 'fs';
import path from 'path';

const API_KEY = process.env.OPENAI_API_KEY || 'ee820fea280331c166dcf23c333bc38d6e291bac5e06be6453f9f9eb6eed1673';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://compass.llm.shopee.io/compass-api/v1';

const IMAGE_PATH = '/Users/huanyu.guo/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_wyhicerbnt9u22_4363/msg/file/2026-03/Screenshot_2026_0307_164557.jpg';

const PROMPT = `请逐行分析这张券商APP持仓截图中的每一条持仓记录。
输出格式（每行一条）：序号. 名称 (代码) - 持仓数量 - 市值
最后统计：总共识别了多少条持仓记录，总市值多少。`;

const VISION_MODELS = [
  'Qwen2.5-VL-72B-Instruct',
  'Qwen2.5-VL-7B-Instruct',
  'Qwen2.5-VL-7B-Monee',
  'compass-vl',
  'compass-llvm',
  'compass-llvm-monee',
  'chatgpt-4o-latest',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-5',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5-mini',
  'gpt-5-nano',
  'gemini-2.0-flash',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-5@20250929',
  'claude-3-7-sonnet@20250219',
  'o3',
  'o4-mini',
  'glm-5',
];

const imgBuf = fs.readFileSync(IMAGE_PATH);
const base64 = imgBuf.toString('base64');

const KNOWN_HOLDINGS = [
  '中国海油', '500ETF', '万华化学', '酒ETF', '中国铝业', '黄金ETF',
  '招商银行', '光伏基金', '银华日利', '中国平安', '洋河股份',
  '中远海控', '东方财富', '纳指科技ETF', '游戏ETF', '恒生医疗ETF',
  '创业板ETF', '科创50ETF', '中国互联', '医疗ETF', '300ETF',
  '恒生科技指数ETF', '证券ETF', '芯片ETF', '稀有金属ETF',
];

async function testModel(model) {
  const start = Date.now();
  try {
    const resp = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            ],
          },
        ],
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(120_000),
    });

    const elapsed = Date.now() - start;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return {
        model,
        supportsVision: false,
        error: `HTTP ${resp.status}: ${errText.slice(0, 200)}`,
        elapsed,
      };
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';

    const foundHoldings = KNOWN_HOLDINGS.filter((h) => content.includes(h));
    const has500ETF = content.includes('500ETF') || content.includes('中证500');
    const holdingCountMatch = content.match(/(\d+)\s*条/);
    const reportedCount = holdingCountMatch ? parseInt(holdingCountMatch[1]) : null;

    return {
      model,
      supportsVision: true,
      foundCount: foundHoldings.length,
      totalKnown: KNOWN_HOLDINGS.length,
      has500ETF,
      reportedCount,
      foundHoldings,
      missedHoldings: KNOWN_HOLDINGS.filter((h) => !content.includes(h)),
      elapsed,
      contentLength: content.length,
      content,
    };
  } catch (err) {
    return {
      model,
      supportsVision: false,
      error: err.message?.slice(0, 200) || String(err),
      elapsed: Date.now() - start,
    };
  }
}

async function main() {
  console.log(`Testing ${VISION_MODELS.length} models against screenshot...`);
  console.log(`Image: ${IMAGE_PATH} (${(imgBuf.length / 1024).toFixed(0)} KB)`);
  console.log(`Ground truth: ${KNOWN_HOLDINGS.length} known holdings\n`);

  const results = [];

  for (const model of VISION_MODELS) {
    process.stdout.write(`Testing ${model}... `);
    const result = await testModel(model);
    if (result.supportsVision) {
      console.log(
        `OK - found ${result.foundCount}/${result.totalKnown} holdings, ` +
          `500ETF: ${result.has500ETF ? 'YES' : 'NO'}, ${(result.elapsed / 1000).toFixed(1)}s`,
      );
    } else {
      console.log(`FAILED - ${result.error?.slice(0, 80)}, ${(result.elapsed / 1000).toFixed(1)}s`);
    }
    results.push(result);
  }

  let md = `# 视觉模型对比测试报告\n\n`;
  md += `- 测试时间: ${new Date().toISOString()}\n`;
  md += `- 截图: 银河证券持仓页 (${(imgBuf.length / 1024).toFixed(0)} KB)\n`;
  md += `- Ground Truth: ${KNOWN_HOLDINGS.length} 条已知持仓\n\n`;

  md += `## 结果汇总\n\n`;
  md += `| 模型 | 支持视觉 | 识别数/已知数 | 500ETF | 自报数量 | 耗时(s) |\n`;
  md += `|------|---------|-------------|--------|---------|--------|\n`;

  const sorted = [...results].sort((a, b) => (b.foundCount || 0) - (a.foundCount || 0));
  for (const r of sorted) {
    if (r.supportsVision) {
      md += `| ${r.model} | Yes | ${r.foundCount}/${r.totalKnown} | ${r.has500ETF ? 'Yes' : 'No'} | ${r.reportedCount ?? '-'} | ${(r.elapsed / 1000).toFixed(1)} |\n`;
    } else {
      md += `| ${r.model} | No | - | - | - | ${(r.elapsed / 1000).toFixed(1)} |\n`;
    }
  }

  md += `\n## 各模型详细输出\n\n`;
  for (const r of sorted) {
    md += `### ${r.model}\n\n`;
    if (r.supportsVision) {
      md += `- 识别: ${r.foundCount}/${r.totalKnown}, 500ETF: ${r.has500ETF ? 'Yes' : 'No'}\n`;
      md += `- 遗漏: ${r.missedHoldings.length > 0 ? r.missedHoldings.join(', ') : '无'}\n`;
      md += `- 耗时: ${(r.elapsed / 1000).toFixed(1)}s\n\n`;
      md += `<details><summary>完整输出</summary>\n\n\`\`\`\n${r.content}\n\`\`\`\n\n</details>\n\n`;
    } else {
      md += `- 错误: ${r.error}\n\n`;
    }
  }

  const outPath = path.join(process.cwd(), 'logs', 'vision-model-comparison.md');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf-8');
  console.log(`\nReport saved to ${outPath}`);
}

main().catch(console.error);
