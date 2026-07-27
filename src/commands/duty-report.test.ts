import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectDutyCommand,
  isDutyReportAutoSendPaused,
} from './duty-report.js';

const fullDetection = {
  triggerUc: false,
  triggerFunder: false,
  triggerPlatform: false,
};

describe('detectDutyCommand', () => {
  it('returns null for unrelated text', () => {
    expect(detectDutyCommand('你好')).toBeNull();
    expect(detectDutyCommand('今天天气怎么样')).toBeNull();
    expect(detectDutyCommand('')).toBeNull();
  });

  it('triggers UC for plain duty keywords', () => {
    expect(detectDutyCommand('值班日报')).toEqual({
      ...fullDetection,
      triggerUc: true,
    });
    expect(detectDutyCommand('发值班邮件')).toEqual({
      ...fullDetection,
      triggerUc: true,
    });
    expect(detectDutyCommand('@Andy 值班日报')).toEqual({
      ...fullDetection,
      triggerUc: true,
    });
    expect(detectDutyCommand('uc值班邮件')).toEqual({
      ...fullDetection,
      triggerUc: true,
    });
  });

  it('triggers Funding for funding keywords', () => {
    expect(detectDutyCommand('funding值班邮件')).toEqual({
      ...fullDetection,
      triggerFunder: true,
    });
    expect(detectDutyCommand('大促值班')).toEqual({
      ...fullDetection,
      triggerFunder: true,
    });
    expect(detectDutyCommand('funding日报')).toEqual({
      ...fullDetection,
      triggerFunder: true,
    });
    expect(detectDutyCommand('funding duty')).toEqual({
      ...fullDetection,
      triggerFunder: true,
    });
  });

  it('triggers both when both keywords present', () => {
    expect(detectDutyCommand('uc和funding值班邮件')).toEqual({
      ...fullDetection,
      triggerUc: true,
      triggerFunder: true,
    });
  });
});

describe('isDutyReportAutoSendPaused', () => {
  const prev = process.env.NANOCLAW_DUTY_REPORTS_DISABLED;

  beforeEach(() => {
    delete process.env.NANOCLAW_DUTY_REPORTS_DISABLED;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NANOCLAW_DUTY_REPORTS_DISABLED;
    else process.env.NANOCLAW_DUTY_REPORTS_DISABLED = prev;
  });

  it('is true when NANOCLAW_DUTY_REPORTS_DISABLED is 1', () => {
    process.env.NANOCLAW_DUTY_REPORTS_DISABLED = '1';
    expect(isDutyReportAutoSendPaused()).toBe(true);
  });
});
