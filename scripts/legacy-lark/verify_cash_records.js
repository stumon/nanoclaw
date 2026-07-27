// 验证所有现金记录
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const tableId = 'tblhHUfS83WUvSCj';
const viewId = 'vewt7pCQgM';
const baseUrl = 'https://open.feishu.cn/open-apis';

async function getAllRecords(token) {
  let allRecords = [];
  let pageToken = null;
  
  do {
    const params = {
      view_id: viewId,
      page_size: 100
    };
    if (pageToken) {
      params.page_token = pageToken;
    }
    
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

async function main() {
  console.log('验证所有现金记录...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    
    const records = await getAllRecords(token);
    
    // 筛选现金记录
    const cashRecords = records.filter(record => {
      const fields = record.fields;
      return fields['资产类型'] === '现金';
    });
    
    console.log(`共找到 ${cashRecords.length} 条现金记录:`);
    console.log('');
    
    // 按资产类型分组
    const cnyCash = cashRecords.filter(r => r.fields['资产'] === 'CNY');
    const usdCash = cashRecords.filter(r => r.fields['资产'] === 'USD');
    const hkdCash = cashRecords.filter(r => r.fields['资产'] === 'HKD');
    
    if (cnyCash.length > 0) {
      console.log('人民币现金 (CNY):');
      cnyCash.forEach((record, index) => {
        const fields = record.fields;
        console.log(`  ${index + 1}. ${fields['平台']}`);
        console.log(`     持仓数量: ${fields['持仓数量'] || 'N/A'}`);
        console.log(`     持仓价值: ${fields['持仓价值'] || 'N/A'}`);
        console.log(`     价格-CNY: ${fields['价格-CNY'] || 'N/A'}`);
        console.log('');
      });
      
      const cnyTotal = cnyCash.reduce((sum, r) => sum + (r.fields['持仓价值'] || 0), 0);
      const cnyTotalQuantity = cnyCash.reduce((sum, r) => sum + (r.fields['持仓数量'] || 0), 0);
      console.log(`  CNY 总计: 持仓价值 ${cnyTotal}, 持仓数量 ${cnyTotalQuantity}`);
      console.log('');
    }
    
    if (usdCash.length > 0) {
      console.log('美元现金 (USD):');
      usdCash.forEach((record, index) => {
        const fields = record.fields;
        console.log(`  ${index + 1}. ${fields['平台']}`);
        console.log(`     持仓数量: ${fields['持仓数量'] || 'N/A'}`);
        console.log(`     持仓价值: ${fields['持仓价值'] || 'N/A'}`);
        console.log(`     价格-USD: ${fields['价格-USD'] || 'N/A'}`);
        console.log('');
      });
    }
    
    if (hkdCash.length > 0) {
      console.log('港币现金 (HKD):');
      hkdCash.forEach((record, index) => {
        const fields = record.fields;
        console.log(`  ${index + 1}. ${fields['平台']}`);
        console.log(`     持仓数量: ${fields['持仓数量'] || 'N/A'}`);
        console.log(`     持仓价值: ${fields['持仓价值'] || 'N/A'}`);
        console.log('');
      });
    }
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

