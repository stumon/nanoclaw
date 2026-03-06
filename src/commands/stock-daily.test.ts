import { describe, it, expect } from 'vitest';
import { isStockDailyRerunCommand } from './stock-daily.js';

describe('isStockDailyRerunCommand', () => {
  it('matches strict command variants', () => {
    expect(isStockDailyRerunCommand('重跑今日股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('重跑当日股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('重跑今天的股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('@Andy 重跑今日股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('@Andy   重跑今日股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('重跑一下今日股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('再跑一遍今日股票数据')).toBe(true);
  });

  it('matches loose phrasing with core words', () => {
    expect(isStockDailyRerunCommand('@Andy 麻烦重跑一下股票数据')).toBe(true);
    expect(isStockDailyRerunCommand('能不能重新跑一下今天股票数据？')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(isStockDailyRerunCommand('今天股票数据怎么样')).toBe(false);
    expect(isStockDailyRerunCommand('重跑一下')).toBe(false);
    expect(isStockDailyRerunCommand('股票')).toBe(false);
    expect(isStockDailyRerunCommand('')).toBe(false);
  });
});

