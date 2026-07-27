// 更新华泰券商账户持仓数据
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const assetTableId = 'tblhHUfS83WUvSCj';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 华泰券商持仓数据（从截图提取 - 本周数据）
const huataiHoldings = [
  // 场内基金
  {
    name: '恒生医药ETF',
    code: '159892',
    assetType: '场内基金',
    quantity: 11900,
    price: 0.863,
    marketValue: 10269.70
  },
  {
    name: '光伏ETF',
    code: '515790',
    assetType: '场内基金',
    quantity: 1400,
    price: 1.018,
    marketValue: 1425.20
  },
  // A股
  {
    name: '万科A',
    code: '000002',
    assetType: 'A股',
    quantity: 300,
    price: 4.960,
    marketValue: 1488.00
  },
  {
    name: '中国电建',
    code: '601669',
    assetType: 'A股',
    quantity: 200,
    price: 5.380,
    marketValue: 1076.00
  }
];

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
  console.log('更新华泰券商账户持仓数据...');
  console.log('');
  
  try {
    const token = await getAccessToken();
    
    // 获取所有现有记录
    const allRecords = await getAllRecords(token, assetTableId);
    
    // 检查是否已存在华泰证券的记录
    const existingHuataiRecords = allRecords.filter(record => {
      const platform = extractText(record.fields['平台']);
      return platform === '华泰证券';
    });
    
    console.log(`现有华泰证券记录数: ${existingHuataiRecords.length}`);
    console.log('');
    
    let createdCount = 0;
    let updatedCount = 0;
    let failedCount = 0;
    
    for (const holding of huataiHoldings) {
      // 查找是否已存在相同资产和平台的记录
      const existingRecord = existingHuataiRecords.find(record => {
        const assetName = extractText(record.fields['资产'] || record.fields['名称']);
        return assetName === holding.name;
      });
      
      const recordFields = {
        '平台': '华泰证券',
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
    }
    
    console.log('');
    console.log('='.repeat(50));
    console.log('更新完成:');
    console.log(`  创建: ${createdCount} 条`);
    console.log(`  更新: ${updatedCount} 条`);
    console.log(`  失败: ${failedCount} 条`);
    console.log('');
    
    // 验证更新结果
    console.log('验证更新结果...');
    const updatedRecords = await getAllRecords(token, assetTableId);
    const huataiRecords = updatedRecords.filter(record => {
      const platform = extractText(record.fields['平台']);
      return platform === '华泰证券';
    });
    
    console.log(`华泰证券记录数: ${huataiRecords.length}`);
    console.log('');
    
    // 按资产类型分组显示
    const funds = huataiRecords.filter(r => extractText(r.fields['资产类型']) === '基金');
    const stocks = huataiRecords.filter(r => extractText(r.fields['资产类型']) === 'A股');
    
    if (funds.length > 0) {
      console.log('基金记录:');
      funds.forEach((record, index) => {
        const assetName = extractText(record.fields['资产'] || record.fields['名称']);
        const quantity = record.fields['持仓数量'] || 0;
        const price = record.fields['价格-CNY'] || 0;
        const value = record.fields['持仓价值'] || 0;
        console.log(`  ${index + 1}. ${assetName} - 持仓: ${quantity}, 价格: ${price}, 价值: ${value}`);
      });
      console.log('');
    }
    
    if (stocks.length > 0) {
      console.log('A股记录:');
      stocks.forEach((record, index) => {
        const assetName = extractText(record.fields['资产'] || record.fields['名称']);
        const quantity = record.fields['持仓数量'] || 0;
        const price = record.fields['价格-CNY'] || 0;
        const value = record.fields['持仓价值'] || 0;
        console.log(`  ${index + 1}. ${assetName} - 持仓: ${quantity}, 价格: ${price}, 价值: ${value}`);
      });
      console.log('');
    }
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

