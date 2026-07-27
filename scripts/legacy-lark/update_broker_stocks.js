// 更新券商持仓数据（A股账户）
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const tableId = 'tblhHUfS83WUvSCj';
const viewId = 'vewt7pCQgM';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 券商持仓数据（从截图提取 - 本周数据）
// 注意：ETF和基金标注为"场内基金"，与支付宝的"场外基金"区分
// 资产类型：A股、场内基金、场外基金
const brokerHoldings = [
  { name: '中国平安', code: '601318', quantity: 1100, price: 69.000, marketValue: 75900.00, assetType: 'A股' },
  { name: '黄金ETF', code: '518880', quantity: 5000, price: 9.592, marketValue: 47960.00, assetType: '场内基金' },
  { name: '中国铝业', code: '601600', quantity: 2100, price: 14.050, marketValue: 29505.00, assetType: 'A股' },
  { name: '科创板50', code: '588000', quantity: 4000, price: 1.505, marketValue: 6020.00, assetType: '场内基金' },
  { name: '恒生医疗', code: '513060', quantity: 7400, price: 0.654, marketValue: 4839.60, assetType: '场内基金' },
  { name: '中国广核', code: '003816', quantity: 1000, price: 3.900, marketValue: 3900.00, assetType: 'A股' },
  { name: '国投电力', code: '600886', quantity: 2800, price: 13.300, marketValue: 37240.00, assetType: 'A股' },
];

// 券商账户现金
const brokerCash = {
  available: 34411.27, // 可用资金
  totalAssets: 468432.17, // 总资产
  marketValue: 434020.90, // 总市值
};

async function getAllRecords(token) {
  let allRecords = [];
  let pageToken = null;
  
  do {
    const params = {
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

async function getTableFields(token) {
  const response = await axios.get(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/fields`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data.data.items;
}

async function updateRecord(token, recordId, fields, fieldTypes) {
  const formattedFields = {};
  
  for (const [fieldName, value] of Object.entries(fields)) {
    const field = fieldTypes.find(f => f.field_name === fieldName);
    if (!field) {
      formattedFields[fieldName] = value;
      continue;
    }
    
    switch (field.type) {
      case 2: // 数字类型
        formattedFields[fieldName] = typeof value === 'number' ? value : parseFloat(value);
        break;
      case 3: // 单选类型
        formattedFields[fieldName] = value;
        break;
      case 7: // 复选框类型
        formattedFields[fieldName] = Boolean(value);
        break;
      default:
        formattedFields[fieldName] = value;
    }
  }
  
  const response = await axios.put(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records/${recordId}`,
    {
      fields: formattedFields
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data;
}

async function createRecord(token, fields, fieldTypes) {
  const formattedFields = {};
  
  for (const [fieldName, value] of Object.entries(fields)) {
    const field = fieldTypes.find(f => f.field_name === fieldName);
    if (!field) {
      formattedFields[fieldName] = value;
      continue;
    }
    
    switch (field.type) {
      case 2: // 数字类型
        formattedFields[fieldName] = typeof value === 'number' ? value : parseFloat(value);
        break;
      case 3: // 单选类型
        formattedFields[fieldName] = value;
        break;
      case 7: // 复选框类型
        formattedFields[fieldName] = Boolean(value);
        break;
      default:
        formattedFields[fieldName] = value;
    }
  }
  
  const response = await axios.post(
    `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
    {
      fields: formattedFields
    },
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
  console.log('更新券商持仓数据...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    console.log('✓ Token 获取成功，开始更新数据...');
    console.log('');
    
    const fieldTypes = await getTableFields(token);
    const records = await getAllRecords(token);
    
    // 1. 更新券商账户现金
    console.log('1. 更新券商账户现金...');
    const brokerCashRecord = records.find(record => {
      const fields = record.fields;
      return fields['平台'] === '中国银河证券' &&
             fields['资产'] === 'CNY' &&
             fields['资产类型'] === '现金';
    });
    
    if (brokerCashRecord) {
      console.log(`   更新现有现金记录: ${brokerCashRecord.record_id}`);
      console.log(`   可用资金: ${brokerCash.available}`);
      console.log('');
      
      const updateFields = {
        '持仓数量': brokerCash.available,
        '价格-CNY': 1.0
      };
      
      try {
        const result = await updateRecord(token, brokerCashRecord.record_id, updateFields, fieldTypes);
        if (result.code === 0) {
          console.log('   ✓ 现金记录更新成功');
        } else {
          console.log(`   ✗ 更新失败: ${result.msg}`);
        }
      } catch (error) {
        console.log(`   ✗ 更新失败: ${error.message}`);
      }
    } else {
      console.log('   创建新的现金记录...');
      const newRecordFields = {
        '平台': '中国银河证券',
        '资产': 'CNY',
        '资产类型': '现金',
        '持仓数量': brokerCash.available,
        '价格-CNY': 1.0
      };
      
      try {
        const result = await createRecord(token, newRecordFields, fieldTypes);
        if (result.code === 0) {
          console.log('   ✓ 现金记录创建成功');
        } else {
          console.log(`   ✗ 创建失败: ${result.msg}`);
        }
      } catch (error) {
        console.log(`   ✗ 创建失败: ${error.message}`);
      }
    }
    
    console.log('');
    
    // 2. 更新股票和场内基金持仓
    console.log('2. 更新股票和场内基金持仓...');
    console.log(`   共 ${brokerHoldings.length} 只持仓`);
    console.log('');
    
    let updatedCount = 0;
    let createdCount = 0;
    let errorCount = 0;
    
    for (const holding of brokerHoldings) {
      // 查找现有记录（通过平台和资产名称匹配）
      const existingRecord = records.find(record => {
        const fields = record.fields;
        const assetName = fields['资产'] || '';
        return fields['平台'] === '中国银河证券' &&
               (assetName === holding.name || assetName === holding.code || 
                assetName.includes(holding.name) || holding.name.includes(assetName));
      });
      
      // 构建记录字段
      const recordFields = {
        '平台': '中国银河证券',
        '资产': holding.name,
        '资产类型': holding.assetType, // A股 或 场内基金
        '持仓数量': holding.quantity,
        '价格-CNY': holding.price
      };
      
      if (existingRecord) {
        // 更新现有记录
        try {
          const result = await updateRecord(token, existingRecord.record_id, recordFields, fieldTypes);
          if (result.code === 0) {
            updatedCount++;
            console.log(`   ✓ 更新: ${holding.name} (${holding.quantity}股, ${holding.price}元)`);
          } else {
            errorCount++;
            console.log(`   ✗ 更新失败: ${holding.name} - ${result.msg}`);
          }
        } catch (error) {
          errorCount++;
          console.log(`   ✗ 更新失败: ${holding.name} - ${error.message}`);
        }
      } else {
        // 创建新记录
        try {
          const result = await createRecord(token, recordFields, fieldTypes);
          if (result.code === 0) {
            createdCount++;
            console.log(`   ✓ 创建: ${holding.name} (${holding.quantity}股, ${holding.price}元)`);
          } else {
            errorCount++;
            console.log(`   ✗ 创建失败: ${holding.name} - ${result.msg}`);
          }
        } catch (error) {
          errorCount++;
          console.log(`   ✗ 创建失败: ${holding.name} - ${error.message}`);
        }
      }
      
      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log('');
    console.log('='.repeat(50));
    console.log('更新完成！');
    console.log(`   更新记录: ${updatedCount} 条`);
    console.log(`   新建记录: ${createdCount} 条`);
    console.log(`   失败记录: ${errorCount} 条`);
    console.log('');
    console.log('注意:');
    console.log('- ETF和基金已标注为"场内基金"，与支付宝的"场外基金"区分');
    console.log('- 持仓价值会根据公式自动计算');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

