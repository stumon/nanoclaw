// 综合资产更新脚本 - 一次性更新所有平台的资产数据
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const tableId = 'tblhHUfS83WUvSCj';
const baseUrl = 'https://open.feishu.cn/open-apis';

// ==================== 本周资产数据（从截图提取 2026-02-xx） ====================

// 中国银河证券持仓数据 (区分A股个股和场内基金ETF)
const galaxyHoldings = [
  { name: '黄金ETF', code: '', quantity: 5000, price: 10.873, assetType: '场内基金' },
  { name: '中国平安', code: '601318', quantity: 1100, price: 62.67, assetType: 'A股' },
  { name: '中国铝业', code: '601600', quantity: 2100, price: 13.97, assetType: 'A股' },
  { name: '中国海油', code: '600938', quantity: 1400, price: 40.49, assetType: 'A股' },
  { name: '500ETF', code: '510500', quantity: 5900, price: 8.421, assetType: '场内基金' },
  { name: '万华化学', code: '600309', quantity: 500, price: 93, assetType: 'A股' },
  { name: '恒生医疗', code: '', quantity: 7400, price: 0.581, assetType: '场内基金' },
  { name: '光伏基金', code: '', quantity: 33300, price: 0.699, assetType: '场内基金' },
  { name: '稀金属', code: '', quantity: 16900, price: 1.557, assetType: '场内基金' },
  { name: '伊利股份', code: '600887', quantity: 500, price: 26.21, assetType: 'A股' },
  { name: '恒生互联', code: '', quantity: 15600, price: 0.45, assetType: '场内基金' },
  { name: '东方电气', code: '600875', quantity: 100, price: 44.22, assetType: 'A股' },
  { name: '纳指', code: '', quantity: 7000, price: 1.912, assetType: '场内基金' },
  { name: '创业板', code: '', quantity: 2400, price: 3.225, assetType: '场内基金' },
  { name: '中国广核', code: '003816', quantity: 3000, price: 4.15, assetType: 'A股' },
  { name: '牧原股份', code: '002714', quantity: 100, price: 49.34, assetType: 'A股' },
  { name: '中国移动', code: '600941', quantity: 100, price: 95.61, assetType: 'A股' },
  { name: '招商银行', code: '600036', quantity: 500, price: 39.2, assetType: 'A股' },
  { name: '军工龙头', code: '', quantity: 19000, price: 0.885, assetType: '场内基金' },
  { name: '美的集团', code: '000333', quantity: 100, price: 76.52, assetType: 'A股' },
  { name: '紫金矿业', code: '601899', quantity: 600, price: 37.1, assetType: 'A股' },
  { name: '长江电力', code: '600900', quantity: 400, price: 27.14, assetType: 'A股' },
  { name: '医疗ETF', code: '', quantity: 65400, price: 0.342, assetType: '场内基金' },
  { name: '酒ETF', code: '', quantity: 17700, price: 0.51, assetType: '场内基金' },
  { name: '国投电力', code: '600886', quantity: 1400, price: 13.85, assetType: 'A股' },
];
const galaxyCash = 19093.61;

// 盈透证券(IBKR)美股持仓数据
// 价格单位：USD，存储时转换为CNY（汇率7.0）
const USD_CNY_RATE = 7.0;
const ibkrHoldings = [
  { name: 'SNDK', code: 'SNDK', quantity: 1, priceUSD: 522, assetType: '美股' },
  { name: 'SMCI', code: 'SMCI', quantity: 10, priceUSD: 31.25, assetType: '美股' },
  { name: 'META', code: 'META', quantity: 2, priceUSD: 641.33, assetType: '美股' },
  { name: 'LRCX', code: 'LRCX', quantity: 5, priceUSD: 199.69, assetType: '美股' },
  { name: 'KEYS', code: 'KEYS', quantity: 1, priceUSD: 262.22, assetType: '美股' },
  { name: 'INTC', code: 'INTC', quantity: 20, priceUSD: 43.34, assetType: '美股' },
  { name: 'IBKR', code: 'IBKR', quantity: 2.164, priceUSD: 66.61, assetType: '美股' },
  { name: 'GLW', code: 'GLW', quantity: 1, priceUSD: 121.6, assetType: '美股' },
];
const ibkrCash = 1340;  // USD现金

// 华泰证券持仓数据 (ETF)
const huataiHoldings = [
  { name: '恒生医药ETF', code: '159892', quantity: 11900, price: 0.828, assetType: '场内基金' },
];

// 川财证券持仓数据 (4只股票)
const chuancaiHoldings = [
  { name: '东方电气', code: '', quantity: 200, price: 44.22, assetType: 'A股' },
  { name: '紫金矿业', code: '', quantity: 100, price: 37.1, assetType: 'A股' },
  { name: '湖南白银', code: '', quantity: 1500, price: 14.87, assetType: 'A股' },
  { name: '白银有色', code: '', quantity: 2600, price: 10.05, assetType: 'A股' },
];
const chuancaiCash = 365.78;

// 支付宝数据
const alipayData = {
  cash: 16963,  // 余额宝
  fund: 47678.51,  // 基金
};

// 云闪付现金 (所有银行余额汇总)
const yunShanFuCash = 132027.10;

// 招商银行基金
const zhaoShangFund = 525463.9;

// ==================== 辅助函数 ====================

async function getAllRecords(token) {
  let allRecords = [];
  let pageToken = null;
  
  do {
    const params = { page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    
    const response = await axios.get(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
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

async function createRecord(token, fields) {
  const response = await axios.post(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
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

async function deleteRecord(token, recordId) {
  const response = await axios.delete(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records/${recordId}`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

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

// 删除指定平台的所有记录
async function deleteAllRecordsForPlatform(token, records, platform) {
  const platformRecords = records.filter(record => {
    const recordPlatform = extractText(record.fields['平台']);
    return recordPlatform === platform;
  });
  
  let deleted = 0;
  for (const record of platformRecords) {
    try {
      await deleteRecord(token, record.record_id);
      deleted++;
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      console.log(`   ⚠ 删除失败: ${record.record_id}`);
    }
  }
  return deleted;
}

// 创建持仓记录
async function createHolding(token, platform, holding) {
  // 如果美股有价格转换
  let price = holding.price;
  if (holding.priceUSD && typeof USD_CNY_RATE !== 'undefined') {
    price = Math.round(holding.priceUSD * USD_CNY_RATE * 100) / 100;
  }

  await createRecord(token, {
    '平台': platform,
    '资产': holding.name,
    '资产类型': holding.assetType,
    '持仓数量': holding.quantity,
    '价格-CNY': price
  });
}

// 创建现金记录
async function createCash(token, platform, amount, currency = 'CNY', rate = 1.0) {
  await createRecord(token, {
    '平台': platform,
    '资产': currency,
    '资产类型': '现金',
    '持仓数量': amount,
    '价格-CNY': rate
  });
}

async function updateRecord(token, recordId, fields) {
  const response = await axios.put(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records/${recordId}`,
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

// ==================== 主函数 ====================

async function main() {
  console.log('='.repeat(60));
  console.log('综合资产更新脚本 (删除后重建模式)');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    const token = await getAccessToken();
    console.log('✓ Token 获取成功');
    console.log('');
    
    const records = await getAllRecords(token);
    console.log(`✓ 获取到 ${records.length} 条现有记录`);
    console.log('');
    
    let stats = { deleted: 0, created: 0, updated: 0, failed: 0 };
    
    // 1. 中国银河证券 - 删除后重建
    console.log('【1】更新中国银河证券...');
    const galaxyDeleted = await deleteAllRecordsForPlatform(token, records, '中国银河证券');
    console.log(`   ✓ 删除旧记录: ${galaxyDeleted} 条`);
    stats.deleted += galaxyDeleted;
    
    for (const holding of galaxyHoldings) {
      try {
        await createHolding(token, '中国银河证券', holding);
        console.log(`   ✓ 创建: ${holding.name}`);
        stats.created++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        console.log(`   ✗ 失败: ${holding.name} - ${e.message}`);
        stats.failed++;
      }
    }
    try {
      await createCash(token, '中国银河证券', galaxyCash);
      console.log(`   ✓ 创建现金: ${galaxyCash}`);
      stats.created++;
    } catch (e) {
      console.log(`   ✗ 现金创建失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 2. 盈透证券(IBKR) - 删除后重建 (同时删除"美股"和"盈透证券"平台的旧记录)
    console.log('【2】更新盈透证券(IBKR)美股...');
    const ibkrDeleted = await deleteAllRecordsForPlatform(token, records, '盈透证券');
    const usStockDeleted = await deleteAllRecordsForPlatform(token, records, '美股');
    console.log(`   ✓ 删除旧记录: ${ibkrDeleted + usStockDeleted} 条 (盈透证券: ${ibkrDeleted}, 美股: ${usStockDeleted})`);
    stats.deleted += ibkrDeleted + usStockDeleted;
    
    for (const holding of ibkrHoldings) {
      try {
        await createHolding(token, '盈透证券', holding);
        console.log(`   ✓ 创建: ${holding.name}`);
        stats.created++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        console.log(`   ✗ 失败: ${holding.name} - ${e.message}`);
        stats.failed++;
      }
    }
    try {
      await createCash(token, '盈透证券', ibkrCash, 'USD', USD_CNY_RATE);
      console.log(`   ✓ 创建USD现金: ${ibkrCash}`);
      stats.created++;
    } catch (e) {
      console.log(`   ✗ USD现金创建失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 3. 华泰证券 - 删除后重建
    console.log('【3】更新华泰证券...');
    const huataiDeleted = await deleteAllRecordsForPlatform(token, records, '华泰证券');
    console.log(`   ✓ 删除旧记录: ${huataiDeleted} 条`);
    stats.deleted += huataiDeleted;
    
    for (const holding of huataiHoldings) {
      try {
        await createHolding(token, '华泰证券', holding);
        console.log(`   ✓ 创建: ${holding.name}`);
        stats.created++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        console.log(`   ✗ 失败: ${holding.name} - ${e.message}`);
        stats.failed++;
      }
    }
    console.log('');
    
    // 3.5 川财证券 - 删除后重建
    console.log('【3.5】更新川财证券...');
    const chuancaiDeleted = await deleteAllRecordsForPlatform(token, records, '川财证券');
    console.log(`   ✓ 删除旧记录: ${chuancaiDeleted} 条`);
    stats.deleted += chuancaiDeleted;
    
    for (const holding of chuancaiHoldings) {
      try {
        await createHolding(token, '川财证券', holding);
        console.log(`   ✓ 创建: ${holding.name}`);
        stats.created++;
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {
        console.log(`   ✗ 失败: ${holding.name} - ${e.message}`);
        stats.failed++;
      }
    }
    try {
      await createCash(token, '川财证券', chuancaiCash);
      console.log(`   ✓ 创建现金: ${chuancaiCash}`);
      stats.created++;
    } catch (e) {
      console.log(`   ✗ 现金创建失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 4. 支付宝 - 更新或创建
    console.log('【4】更新支付宝...');
    try {
      // 余额宝（货币基金）
      const alipayMoneyRecord = records.find(record => {
        const platform = extractText(record.fields['平台']);
        const assetType = extractText(record.fields['资产类型']);
        return platform === '支付宝' && (assetType === '货币基金' || assetType === '现金');
      });
      if (alipayMoneyRecord) {
        await updateRecord(token, alipayMoneyRecord.record_id, {
          '资产类型': '现金',
          '持仓数量': alipayData.cash,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 更新余额宝: ${alipayData.cash}`);
        stats.updated++;
      } else {
        await createRecord(token, {
          '平台': '支付宝',
          '资产': '余额宝',
          '资产类型': '现金',
          '持仓数量': alipayData.cash,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 创建余额宝: ${alipayData.cash}`);
        stats.created++;
      }
      
      // 基金
      const alipayFundRecord = records.find(record => {
        const platform = extractText(record.fields['平台']);
        const assetType = extractText(record.fields['资产类型']);
        return platform === '支付宝' && assetType === '基金';
      });
      if (alipayFundRecord) {
        await updateRecord(token, alipayFundRecord.record_id, {
          '持仓数量': alipayData.fund,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 更新基金: ${alipayData.fund}`);
        stats.updated++;
      } else {
        await createRecord(token, {
          '平台': '支付宝',
          '资产': '基金组合',
          '资产类型': '基金',
          '持仓数量': alipayData.fund,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 创建基金: ${alipayData.fund}`);
        stats.created++;
      }
    } catch (e) {
      console.log(`   ✗ 支付宝更新失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 5. 云闪付现金 - 删除旧银行记录后更新
    console.log('【5】更新云闪付...');
    // 删除旧的单独银行现金记录
    const oldBanks = ['工商银行', '华夏银行', '兴业银行'];
    for (const bankName of oldBanks) {
      const bankDeleted = await deleteAllRecordsForPlatform(token, records, bankName);
      if (bankDeleted > 0) {
        console.log(`   ✓ 删除旧记录 ${bankName}: ${bankDeleted} 条`);
        stats.deleted += bankDeleted;
      }
    }
    try {
      const yunRecord = records.find(record => {
        const platform = extractText(record.fields['平台']);
        return platform === '云闪付';
      });
      if (yunRecord) {
        await updateRecord(token, yunRecord.record_id, {
          '持仓数量': yunShanFuCash,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 更新云闪付现金: ${yunShanFuCash}`);
        stats.updated++;
      } else {
        await createCash(token, '云闪付', yunShanFuCash);
        console.log(`   ✓ 创建云闪付现金: ${yunShanFuCash}`);
        stats.created++;
      }
    } catch (e) {
      console.log(`   ✗ 云闪付更新失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 6. 招商银行基金 - 删除现金记录，更新/创建基金记录
    console.log('【6】更新招商银行基金...');
    // 先删除招商银行的现金记录（如果有）
    const zhaoshangCashRecord = records.find(record => {
      const platform = extractText(record.fields['平台']);
      const assetType = extractText(record.fields['资产类型']);
      return platform === '招商银行' && assetType === '现金';
    });
    if (zhaoshangCashRecord) {
      try {
        await deleteRecord(token, zhaoshangCashRecord.record_id);
        console.log(`   ✓ 删除招商银行旧现金记录`);
        stats.deleted++;
      } catch (e) {
        console.log(`   ⚠ 删除招商银行现金记录失败`);
      }
    }
    // 更新/创建基金记录
    try {
      const zhaoshangFundRecord = records.find(record => {
        const platform = extractText(record.fields['平台']);
        const assetType = extractText(record.fields['资产类型']);
        return platform === '招商银行' && assetType === '基金';
      });
      if (zhaoshangFundRecord) {
        await updateRecord(token, zhaoshangFundRecord.record_id, {
          '持仓数量': zhaoShangFund,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 更新招商银行基金: ${zhaoShangFund}`);
        stats.updated++;
      } else {
        await createRecord(token, {
          '平台': '招商银行',
          '资产': '基金',
          '资产类型': '基金',
          '持仓数量': zhaoShangFund,
          '价格-CNY': 1.0
        });
        console.log(`   ✓ 创建招商银行基金: ${zhaoShangFund}`);
        stats.created++;
      }
    } catch (e) {
      console.log(`   ✗ 招商银行基金更新失败: ${e.message}`);
      stats.failed++;
    }
    console.log('');
    
    // 统计
    console.log('='.repeat(60));
    console.log('更新完成！');
    console.log(`   删除: ${stats.deleted} 条`);
    console.log(`   创建: ${stats.created} 条`);
    console.log(`   更新: ${stats.updated} 条`);
    console.log(`   失败: ${stats.failed} 条`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误详情:', JSON.stringify(error.response.data, null, 2));
    }
    console.log('');
    console.log('如果是 token 过期错误，请运行以下命令获取新 token：');
    console.log('   node refresh_user_token.js');
    console.log('');
  }
}

main();
