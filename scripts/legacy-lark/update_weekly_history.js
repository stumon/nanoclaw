// 更新历史周资产数据
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const weeklyTableId = 'tbllsUyyZ23A4Kxx';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 历史周数据（从聊天记录中提取的截图数据）
const weeklyHistory = [
  {
    week: '03周',
    date: '01-17',
    timestamp: new Date('2026-01-17 16:52').getTime(),
    data: {
      // 第一次提供的截图数据 (01-17)
      金融资产: 591754,
      A股金额: 451645.90,  // 银河 + 华泰 + 川财 股票/ETF
      美股金额: 0,
      基金金额: 50797.18,  // 支付宝基金
      现金金额: 89310.92,  // 余额宝5001.74 + 银行60196.81 + 券商现金24112.37
    }
  }
];

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

async function updateRecord(token, recordId, fields) {
  const response = await axios.put(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${weeklyTableId}/records/${recordId}`,
    { fields },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

async function main() {
  console.log('='.repeat(60));
  console.log('更新历史周资产数据');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    const token = await getAccessToken();
    console.log('✓ Token 获取成功');
    
    const records = await getWeeklyRecords(token);
    console.log(`✓ 获取到 ${records.length} 条周记录`);
    console.log('');
    
    // 更新第3周数据 (01-17)
    const week3Record = records.find(r => {
      const weekLabel = extractText(r.fields['年度第几周']);
      return weekLabel === '03周';
    });
    
    if (week3Record) {
      console.log('【更新第3周 (01-17)】');
      const week3Data = weeklyHistory[2].data;
      
      await updateRecord(token, week3Record.record_id, {
        '金融资产': week3Data.金融资产,
        'A股金额': week3Data.A股金额,
        '美股金额': week3Data.美股金额,
        '基金金额': week3Data.基金金额,
        '现金金额': week3Data.现金金额,
      });
      
      console.log(`   金融资产: ¥${week3Data.金融资产.toLocaleString()}`);
      console.log(`   A股金额:  ¥${week3Data.A股金额.toLocaleString()}`);
      console.log(`   美股金额: ¥${week3Data.美股金额.toLocaleString()}`);
      console.log(`   基金金额: ¥${week3Data.基金金额.toLocaleString()}`);
      console.log(`   现金金额: ¥${week3Data.现金金额.toLocaleString()}`);
      console.log('   ✓ 更新成功');
    } else {
      console.log('⚠ 未找到第3周记录');
    }
    
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
