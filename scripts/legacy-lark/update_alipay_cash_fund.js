// 更新支付宝的现金和基金
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const tableId = 'tblhHUfS83WUvSCj';
const viewId = 'vewt7pCQgM';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 支付宝更新数据（从截图提取 - 本周数据）
const alipayUpdates = {
  cash: {
    amount: 5000.82,  // 余额宝 5000.82
    priceCNY: 1.0
  },
  fund: {
    amount: 50417.36,  // 基金 50417.36
    priceCNY: 1.0
  },
  brokerage: {
    amount: 114.60,  // 券商理财 114.60
    priceCNY: 1.0
  }
};

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
  console.log('更新支付宝的现金和基金...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    console.log('✓ Token 获取成功，开始更新数据...');
    console.log('');
    
    const fieldTypes = await getTableFields(token);
    const records = await getAllRecords(token);
    
    // 1. 更新支付宝现金
    console.log('1. 更新支付宝现金...');
    const alipayCashRecord = records.find(record => {
      const fields = record.fields;
      return fields['平台'] === '支付宝' &&
             fields['资产'] === 'CNY' &&
             fields['资产类型'] === '现金';
    });
    
    if (alipayCashRecord) {
      console.log(`   记录 ID: ${alipayCashRecord.record_id}`);
      console.log(`   旧持仓数量: ${alipayCashRecord.fields['持仓数量'] || 'N/A'}`);
      console.log(`   新持仓数量: ${alipayUpdates.cash.amount}`);
      console.log('');
      
      const updateFields = {
        '持仓数量': alipayUpdates.cash.amount,
        '价格-CNY': alipayUpdates.cash.priceCNY
      };
      
      try {
        const result = await updateRecord(token, alipayCashRecord.record_id, updateFields, fieldTypes);
        if (result.code === 0) {
          console.log(`   ✓ 更新成功`);
        } else {
          console.log(`   ✗ 更新失败: ${result.msg}`);
        }
      } catch (error) {
        console.log(`   ✗ 更新失败: ${error.message}`);
      }
    } else {
      console.log('   未找到支付宝现金记录，创建新记录...');
      const newRecordFields = {
        '平台': '支付宝',
        '资产': 'CNY',
        '资产类型': '现金',
        '持仓数量': alipayUpdates.cash.amount,
        '价格-CNY': alipayUpdates.cash.priceCNY
      };
      
      try {
        const result = await createRecord(token, newRecordFields, fieldTypes);
        if (result.code === 0) {
          console.log(`   ✓ 创建成功`);
        } else {
          console.log(`   ✗ 创建失败: ${result.msg}`);
        }
      } catch (error) {
        console.log(`   ✗ 创建失败: ${error.message}`);
      }
    }
    
    console.log('');
    
    // 2. 更新支付宝基金
    console.log('2. 更新支付宝基金...');
    
    // 查找支付宝的基金记录（可能是"债券"或其他基金名称）
    const alipayFundRecords = records.filter(record => {
      const fields = record.fields;
      return fields['平台'] === '支付宝' &&
             fields['资产类型'] === '基金';
    });
    
    console.log(`   找到 ${alipayFundRecords.length} 条支付宝基金记录`);
    
    if (alipayFundRecords.length > 0) {
      // 如果有多条基金记录，需要确定更新哪一条
      // 通常"债券"可能是主要的基金账户
      const bondFund = alipayFundRecords.find(r => r.fields['资产'] === '债券');
      
      if (bondFund) {
        console.log(`   更新"债券"基金记录:`);
        console.log(`   记录 ID: ${bondFund.record_id}`);
        console.log(`   旧持仓数量: ${bondFund.fields['持仓数量'] || 'N/A'}`);
        console.log(`   新持仓数量: ${alipayUpdates.fund.amount}`);
        console.log('');
        
        const updateFields = {
          '持仓数量': alipayUpdates.fund.amount,
          '价格-CNY': alipayUpdates.fund.priceCNY
        };
        
        try {
          const result = await updateRecord(token, bondFund.record_id, updateFields, fieldTypes);
          if (result.code === 0) {
            console.log(`   ✓ 更新成功`);
          } else {
            console.log(`   ✗ 更新失败: ${result.msg}`);
          }
        } catch (error) {
          console.log(`   ✗ 更新失败: ${error.message}`);
        }
      } else {
        // 如果没有"债券"记录，更新第一条基金记录
        console.log(`   更新第一条基金记录:`);
        const firstFund = alipayFundRecords[0];
        console.log(`   资产名称: ${firstFund.fields['资产']}`);
        console.log(`   记录 ID: ${firstFund.record_id}`);
        console.log(`   旧持仓数量: ${firstFund.fields['持仓数量'] || 'N/A'}`);
        console.log(`   新持仓数量: ${alipayUpdates.fund.amount}`);
        console.log('');
        
        const updateFields = {
          '持仓数量': alipayUpdates.fund.amount,
          '价格-CNY': alipayUpdates.fund.priceCNY
        };
        
        try {
          const result = await updateRecord(token, firstFund.record_id, updateFields, fieldTypes);
          if (result.code === 0) {
            console.log(`   ✓ 更新成功`);
          } else {
            console.log(`   ✗ 更新失败: ${result.msg}`);
          }
        } catch (error) {
          console.log(`   ✗ 更新失败: ${error.message}`);
        }
      }
    } else {
      // 如果没有基金记录，创建新的"债券"基金记录
      console.log('   未找到支付宝基金记录，创建新记录...');
      const newRecordFields = {
        '平台': '支付宝',
        '资产': '债券',
        '资产类型': '基金',
        '持仓数量': alipayUpdates.fund.amount,
        '价格-CNY': alipayUpdates.fund.priceCNY
      };
      
      try {
        const result = await createRecord(token, newRecordFields, fieldTypes);
        if (result.code === 0) {
          console.log(`   ✓ 创建成功`);
        } else {
          console.log(`   ✗ 创建失败: ${result.msg}`);
        }
      } catch (error) {
        console.log(`   ✗ 创建失败: ${error.message}`);
      }
    }
    
    console.log('');
    console.log('='.repeat(50));
    console.log('更新完成！');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

