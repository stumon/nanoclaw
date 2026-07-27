// 周资产变化统计脚本 - 自动计算各资产类型的周变化
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const assetTableId = 'tblhHUfS83WUvSCj';      // 资产表格
const weeklyTableId = 'tbllsUyyZ23A4Kxx';     // 周资产变化表格
const baseUrl = 'https://open.feishu.cn/open-apis';

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    return value[0].text || value[0].name || String(value[0]);
  }
  if (typeof value === 'object' && value !== null) {
    return value.text || value.name || String(value);
  }
  return String(value || '');
}

// 获取资产表格所有记录
async function getAssetRecords(token) {
  let allRecords = [];
  let pageToken = null;
  
  do {
    const params = { page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    
    const response = await axios.get(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${assetTableId}/records`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params
      }
    );
    
    if (response.data.data.items) {
      allRecords = allRecords.concat(response.data.data.items);
    }
    pageToken = response.data.data.page_token;
  } while (pageToken);
  
  return allRecords;
}

// 获取周资产变化表格所有记录
async function getWeeklyRecords(token) {
  let allRecords = [];
  let pageToken = null;
  
  do {
    const params = { page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    
    const response = await axios.get(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${weeklyTableId}/records`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        params
      }
    );
    
    if (response.data.data.items) {
      allRecords = allRecords.concat(response.data.data.items);
    }
    pageToken = response.data.data.page_token;
  } while (pageToken);
  
  return allRecords;
}

// 计算各资产类型的总值（区分A股个股和场内基金ETF）
function calculateAssetSummary(records) {
  const summary = {
    'A股': 0,         // A股个股
    '场内基金': 0,    // 场内ETF
    '美股': 0,
    '基金': 0,        // 场外基金（支付宝、招商银行）
    '现金': 0,        // 现金 + 货币基金
    '金融资产': 0,    // A股 + 场内基金 + 美股 + 基金（不含现金）
    '总资产': 0,      // 金融资产 + 现金
  };
  
  for (const record of records) {
    const assetType = extractText(record.fields['资产类型']);
    const quantity = Number(record.fields['持仓数量']) || 0;
    const price = Number(record.fields['价格-CNY']) || 0;
    const value = quantity * price;
    
    if (assetType === 'A股') {
      summary['A股'] += value;
    } else if (assetType === '场内基金') {
      summary['场内基金'] += value;
    } else if (assetType === '美股') {
      summary['美股'] += value;
    } else if (assetType === '基金') {
      summary['基金'] += value;
    } else if (assetType === '货币基金' || assetType === '现金') {
      summary['现金'] += value;
    }
  }
  
  // 金融资产 = A股 + 场内基金 + 美股 + 基金（不含现金）
  summary['金融资产'] = summary['A股'] + summary['场内基金'] + summary['美股'] + summary['基金'];
  // 总资产 = 金融资产 + 现金
  summary['总资产'] = summary['金融资产'] + summary['现金'];
  
  return summary;
}

// 获取当前周数
function getWeekNumber() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const diff = now - start;
  const oneWeek = 604800000; // 毫秒
  return Math.ceil((diff + start.getDay() * 86400000) / oneWeek);
}

// 格式化日期
function formatDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

// 创建或更新周记录
async function updateWeeklyRecord(token, weeklyRecords, currentSummary) {
  const now = new Date();
  const weekNum = getWeekNumber();
  const weekLabel = `${String(weekNum).padStart(2, '0')}周`;
  
  // 按时间排序，找到最近的记录作为上周数据
  const sortedRecords = weeklyRecords.sort((a, b) => {
    const timeA = a.fields['时间'] || 0;
    const timeB = b.fields['时间'] || 0;
    return timeB - timeA;  // 降序
  });
  
  // 查找本周记录（通过日期匹配当前日期所在周）
  const today = formatDate(now);
  let thisWeekRecord = null;
  let lastWeekRecord = null;
  
  for (let i = 0; i < sortedRecords.length; i++) {
    const record = sortedRecords[i];
    const recordTime = record.fields['时间'];
    if (recordTime) {
      const recordDate = new Date(recordTime);
      const recordWeek = Math.ceil((recordDate - new Date(recordDate.getFullYear(), 0, 1) + new Date(recordDate.getFullYear(), 0, 1).getDay() * 86400000) / 604800000);
      
      if (recordWeek === weekNum) {
        thisWeekRecord = record;
      } else if (recordWeek === weekNum - 1) {
        lastWeekRecord = record;
      }
    }
  }
  
  // 如果没找到上周记录，用最近的非本周记录
  if (!lastWeekRecord && sortedRecords.length > 0) {
    for (const record of sortedRecords) {
      if (record !== thisWeekRecord) {
        lastWeekRecord = record;
        break;
      }
    }
  }
  
  // 计算变化（基于总资产）
  let changes = {};
  if (lastWeekRecord) {
    const last总资产 = Number(lastWeekRecord.fields['总资产']) || Number(lastWeekRecord.fields['金融资产']) || 0;
    
    changes = {
      '总资产变化': currentSummary['总资产'] - last总资产,
      '总资产变化率': last总资产 > 0 ? ((currentSummary['总资产'] - last总资产) / last总资产 * 100).toFixed(2) + '%' : '-',
    };
    console.log(`   找到上周数据，总资产: ¥${last总资产.toLocaleString()}`);
  } else {
    console.log('   未找到上周数据，跳过变化计算');
  }
  
  // 构建更新字段
  const fields = {
    '金融资产': Math.round(currentSummary['金融资产'] * 100) / 100,  // A股+场内基金+美股+基金（不含现金）
    '总资产': Math.round(currentSummary['总资产'] * 100) / 100,      // 金融资产+现金
    'A股金额': Math.round(currentSummary['A股'] * 100) / 100,
    '场内基金金额': Math.round(currentSummary['场内基金'] * 100) / 100,
    '美股金额': Math.round(currentSummary['美股'] * 100) / 100,
    '基金金额': Math.round(currentSummary['基金'] * 100) / 100,
    '现金金额': Math.round(currentSummary['现金'] * 100) / 100,
  };
  
  // 添加总资产变化字段
  if (Object.keys(changes).length > 0) {
    Object.assign(fields, {
      '总资产变化': Math.round(changes['总资产变化'] * 100) / 100,
      '总资产变化率': changes['总资产变化率'],
    });
  }
  
  if (thisWeekRecord) {
    // 更新现有记录
    console.log(`   更新记录ID: ${thisWeekRecord.record_id}`);
    const response = await axios.put(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${weeklyTableId}/records/${thisWeekRecord.record_id}`,
      { fields },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`   API响应: ${response.data.code === 0 ? '成功' : '失败 - ' + response.data.msg}`);
    return { action: 'updated', week: weekLabel };
  } else {
    // 创建新记录（需要包含时间字段）
    fields['时间'] = now.getTime();
    console.log('   创建新记录...');
    const response = await axios.post(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${weeklyTableId}/records`,
      { fields },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log(`   API响应: ${response.data.code === 0 ? '成功' : '失败 - ' + response.data.msg}`);
    return { action: 'created', week: weekLabel };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('周资产变化统计');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    const token = await getAccessToken();
    console.log('✓ Token 获取成功');
    
    // 获取资产数据
    const assetRecords = await getAssetRecords(token);
    console.log(`✓ 获取到 ${assetRecords.length} 条资产记录`);
    
    // 计算汇总
    const summary = calculateAssetSummary(assetRecords);
    console.log('');
    console.log('【本周资产汇总】');
    console.log(`   A股:     ¥${summary['A股'].toLocaleString()}`);
    console.log(`   场内基金: ¥${summary['场内基金'].toLocaleString()}`);
    console.log(`   美股:    ¥${summary['美股'].toLocaleString()}`);
    console.log(`   基金:    ¥${summary['基金'].toLocaleString()}`);
    console.log(`   ─────────────────────`);
    console.log(`   金融资产: ¥${summary['金融资产'].toLocaleString()}（不含现金）`);
    console.log(`   现金:    ¥${summary['现金'].toLocaleString()}`);
    console.log(`   ─────────────────────`);
    console.log(`   总资产:  ¥${summary['总资产'].toLocaleString()}`);
    console.log('');
    
    // 获取周资产变化表格
    const weeklyRecords = await getWeeklyRecords(token);
    console.log(`✓ 获取到 ${weeklyRecords.length} 条周记录`);
    
    // 更新周记录
    const result = await updateWeeklyRecord(token, weeklyRecords, summary);
    console.log(`✓ ${result.action === 'updated' ? '更新' : '创建'}周记录: ${result.week}`);
    
    console.log('');
    console.log('='.repeat(60));
    console.log('完成！');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误详情:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();
