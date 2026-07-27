/**
 * Title-similarity deduplication for intelligence items.
 * Uses trigram-based Jaccard similarity — no external dependencies.
 */

import type { IntelItem } from './intel-fetcher.js';

function trigrams(s: string): Set<string> {
  const normalized = s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  const set = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3));
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Remove near-duplicate items across all categories.
 * When two items are similar (Jaccard >= threshold), keep the one
 * from the higher-priority source (first occurrence).
 */
export function dedup(
  itemsByCategory: Record<string, IntelItem[]>,
  threshold = 0.45,
): Record<string, IntelItem[]> {
  const seen: Array<{ trigrams: Set<string>; item: IntelItem }> = [];
  const result: Record<string, IntelItem[]> = {};

  for (const [cat, items] of Object.entries(itemsByCategory)) {
    result[cat] = [];
    for (const item of items) {
      const tri = trigrams(item.title);
      const isDup = seen.some(
        (s) => jaccardSimilarity(tri, s.trigrams) >= threshold,
      );
      if (!isDup) {
        seen.push({ trigrams: tri, item });
        result[cat].push(item);
      }
    }
  }

  return result;
}
