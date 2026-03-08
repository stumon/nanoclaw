const COMMAND_REGEX =
  /^(?:@[\w-]+\s*)?(?:重跑|重跑下|重新跑|再跑)(?:一下|一遍)?(?:今天|今日|当日)?(?:的)?股票(?:数据)?$/;

export function isStockDailyRerunCommand(raw: string): boolean {
  const text = (raw || '').trim();
  if (!text) return false;

  // Normalize full-width spaces and collapse whitespace
  const normalized = text.replace(/\u3000/g, ' ').replace(/\s+/g, ' ');

  // Primary strict match (exact command-style phrasing)
  if (COMMAND_REGEX.test(normalized)) return true;

  // Secondary loose match: allow small extra words but require core intent words
  const loose = normalized
    .replace(/^@[\w-]+\s*/i, '')
    .replace(/[，。！？!?,.]/g, '')
    .trim();
  if (!loose) return false;
  return (
    /重跑|重新跑|再跑/.test(loose) && /股票/.test(loose) && /数据/.test(loose)
  );
}
