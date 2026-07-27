// 更新银行账户现金余额
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const tableId = 'tblhHUfS83WUvSCj';
const viewId = 'vewt7pCQgM';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 银行现金数据（从截图提取 - 本周数据）
const bankCashData = {
  '工商银行': 62926.80,
  '华夏银行': 766.76,
  '招商银行': 104.72,
  '兴业银行': 0.38
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
  console.log('更新银行账户现金余额...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    console.log('✓ Token 获取成功，开始更新数据...');
    console.log('');
    
    const fieldTypes = await getTableFields(token);
    const records = await getAllRecords(token);
    
    let updatedCount = 0;
    let createdCount = 0;
    let errorCount = 0;
    
    for (const [bankName, cashAmount] of Object.entries(bankCashData)) {
      console.log(`更新 ${bankName}...`);
      
      // 查找现有记录
      const bankCashRecord = records.find(record => {
        const fields = record.fields;
        return fields['平台'] === bankName &&
               fields['资产'] === 'CNY' &&
               fields['资产类型'] === '现金';
      });
      
      if (bankCashRecord) {
        console.log(`   更新现有现金记录: ${bankCashRecord.record_id}`);
        console.log(`   旧余额: ${bankCashRecord.fields['持仓数量'] || 'N/A'}`);
        console.log(`   新余额: ${cashAmount}`);
        console.log('');
        
        const updateFields = {
          '持仓数量': cashAmount,
          '价格-CNY': 1.0
        };
        
        try {
          const result = await updateRecord(token, bankCashRecord.record_id, updateFields, fieldTypes);
          if (result.code === 0) {
            console.log(`   ✓ ${bankName} 现金记录更新成功`);
            updatedCount++;
          } else {
            console.log(`   ✗ 更新失败: ${result.msg}`);
            errorCount++;
          }
        } catch (error) {
          console.log(`   ✗ 更新失败: ${error.message}`);
          errorCount++;
        }
      } else {
        console.log(`   创建新的现金记录...`);
        const newRecordFields = {
          '平台': bankName,
          '资产': 'CNY',
          '资产类型': '现金',
          '持仓数量': cashAmount,
          '价格-CNY': 1.0
        };
        
        try {
          const result = await createRecord(token, newRecordFields, fieldTypes);
          if (result.code === 0) {
            console.log(`   ✓ ${bankName} 现金记录创建成功`);
            createdCount++;
          } else {
            console.log(`   ✗ 创建失败: ${result.msg}`);
            errorCount++;
          }
        } catch (error) {
          console.log(`   ✗ 创建失败: ${error.message}`);
          errorCount++;
        }
      }
      
      console.log('');
      
      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log('='.repeat(50));
    console.log('更新完成！');
    console.log(`   更新记录: ${updatedCount} 条`);
    console.log(`   新建记录: ${createdCount} 条`);
    console.log(`   失败记录: ${errorCount} 条`);
    console.log('');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();


