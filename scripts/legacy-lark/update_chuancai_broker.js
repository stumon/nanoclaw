// 更新川财证券账户持仓数据
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const assetTableId = 'tblhHUfS83WUvSCj';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 川财证券持仓数据（从截图提取 - 本周数据）
const chuancaiHoldings = [
  {
    name: '紫金矿业',
    code: '601899',
    assetType: 'A股',
    quantity: 100,
    price: 37.220,
    marketValue: 3722.00
  }
];

// 川财证券账户现金
const chuancaiCash = {
  available: 3378.90, // 可用资金
  totalAssets: 7100.90, // 总资产
  marketValue: 3722.00, // 总市值
};

async function getAllRecords(token, tableId, viewId = null) {
  let allRecords = [];
  let pageToken = null;
  
  try {
    do {
      const params = {
        page_size: 100
      };
      if (viewId) {
        params.view_id = viewId;
      }
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
      
      if (response.data.data && response.data.data.items) {
        allRecords = allRecords.concat(response.data.data.items);
      }
      
      pageToken = response.data.data?.page_token;
    } while (pageToken);
  } catch (error) {
    console.error('获取记录失败:', error.message);
  }
  
  return allRecords;
}

function extractText(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    if (value.name !== undefined) {
      return value.name;
    }
    if (value.text !== undefined) {
      return value.text;
    }
    if (value.value !== undefined) {
      return String(value.value);
    }
  }
  return String(value || '未知');
}

async function createRecord(token, tableId, fields) {
  try {
    const response = await axios.post(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records`,
      {
        fields: fields
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`创建失败: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function updateRecord(token, tableId, recordId, fields) {
  try {
    const response = await axios.put(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${tableId}/records/${recordId}`,
      {
        fields: fields
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`更新失败: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function main() {
  console.log('更新川财证券账户持仓数据...');
  console.log('');
  
  try {
    const token = await getAccessToken();
    
    // 获取所有现有记录
    const allRecords = await getAllRecords(token, assetTableId);
    
    // 1. 更新川财证券账户现金
    console.log('1. 更新川财证券账户现金...');
    const chuancaiCashRecord = allRecords.find(record => {
      const platform = extractText(record.fields['平台']);
      const asset = extractText(record.fields['资产']);
      const assetType = extractText(record.fields['资产类型']);
      return platform === '川财证券' &&
             asset === 'CNY' &&
             assetType === '现金';
    });
    
    if (chuancaiCashRecord) {
      console.log(`   更新现有现金记录: ${chuancaiCashRecord.record_id}`);
      console.log(`   可用资金: ${chuancaiCash.available}`);
      console.log('');
      
      const updateFields = {
        '持仓数量': chuancaiCash.available,
        '价格-CNY': 1.0
      };
      
      try {
        const result = await updateRecord(token, assetTableId, chuancaiCashRecord.record_id, updateFields);
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
        '平台': '川财证券',
        '资产': 'CNY',
        '资产类型': '现金',
        '持仓数量': chuancaiCash.available,
        '价格-CNY': 1.0
      };
      
      try {
        const result = await createRecord(token, assetTableId, newRecordFields);
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
    
    // 2. 更新股票持仓
    console.log('2. 更新股票持仓...');
    
    // 检查是否已存在川财证券的记录
    const existingChuancaiRecords = allRecords.filter(record => {
      const platform = extractText(record.fields['平台']);
      return platform === '川财证券';
    });
    
    console.log(`现有川财证券记录数: ${existingChuancaiRecords.length}`);
    console.log('');
    
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    
    for (const holding of chuancaiHoldings) {
      // 查找是否已存在相同资产和平台的记录
      const existingRecord = existingChuancaiRecords.find(record => {
        const assetName = extractText(record.fields['资产'] || record.fields['名称']);
        return assetName === holding.name || assetName === holding.code;
      });
      
      const recordFields = {
        '平台': '川财证券',
        '资产': holding.name,
        '资产类型': holding.assetType,
        '持仓数量': holding.quantity,
        '价格-CNY': holding.price
      };
      
      try {
        if (existingRecord) {
          // 更新现有记录
          await updateRecord(token, assetTableId, existingRecord.record_id, recordFields);
          console.log(`✓ 已更新: ${holding.name} (${holding.assetType}) - 持仓: ${holding.quantity}, 价格: ${holding.price}`);
          updatedCount++;
        } else {
          // 创建新记录
          await createRecord(token, assetTableId, recordFields);
          console.log(`✓ 已创建: ${holding.name} (${holding.assetType}) - 持仓: ${holding.quantity}, 价格: ${holding.price}`);
          createdCount++;
        }
      } catch (error) {
        console.log(`✗ 失败: ${holding.name} - ${error.message}`);
        failedCount++;
      }
      
      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log('');
    console.log('='.repeat(50));
    console.log('更新完成:');
    console.log(`  创建: ${createdCount} 条`);
    console.log(`  更新: ${updatedCount} 条`);
    console.log(`  失败: ${failedCount} 条`);
    console.log('');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();


