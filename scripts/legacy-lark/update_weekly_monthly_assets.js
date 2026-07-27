// 更新周资产变化和月资产变化
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 表格ID
const assetTableId = 'tblhHUfS83WUvSCj'; // 资产表格
const weeklyTableId = 'tbllsUyyZ23A4Kxx'; // 周资产变化
const monthlyTableId = 'tblyGhh4iegb5CiD'; // 月资产变化

async function getAllRecords(token, tableId, viewId = null) {
  let allRecords = [];
  let pageToken = null;
  
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
    
    if (response.data.data.items) {
      allRecords = allRecords.concat(response.data.data.items);
    }
    
    pageToken = response.data.data.page_token;
  } while (pageToken);
  
  return allRecords;
}

async function getTableFields(token, tableId) {
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

async function calculateTotalAssets(token) {
  // 获取所有资产记录（使用"所有资产"视图）
  const viewId = 'vew49djSGK';
  const records = await getAllRecords(token, assetTableId, viewId);
  
  // 计算总资产（包括所有类型的资产）
  const totalAssets = records.reduce((sum, record) => {
    const value = record.fields['持仓价值'] || 0;
    return sum + value;
  }, 0);
  
  return {
    totalAssets,
    financialAssets: 0, // 金融资产需要单独计算
    records
  };
}

async function calculateFinancialAssets(token) {
  // 获取金融资产视图的记录
  const viewId = 'vewt7pCQgM';
  const records = await getAllRecords(token, assetTableId, viewId);
  
  // 计算金融资产总和
  const totalFinancialAssets = records.reduce((sum, record) => {
    const value = record.fields['持仓价值'] || 0;
    return sum + value;
  }, 0);
  
  return totalFinancialAssets;
}

async function createRecord(token, tableId, fields, fieldTypes) {
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
      case 5: // 日期类型
        // 日期字段需要时间戳（毫秒）
        if (value instanceof Date) {
          formattedFields[fieldName] = value.getTime();
        } else if (typeof value === 'number') {
          formattedFields[fieldName] = value;
        } else {
          formattedFields[fieldName] = value;
        }
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

// 计算年度第几周
function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function main() {
  console.log('更新周资产变化和月资产变化...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    console.log('✓ Token 获取成功，开始更新数据...');
    console.log('');
    
    // 1. 计算当前资产
    console.log('1. 计算当前资产...');
    const financialAssets = await calculateFinancialAssets(token);
    const assetsData = await calculateTotalAssets(token);
    const totalAssets = assetsData.totalAssets;
    
    console.log(`  金融资产: ${financialAssets.toFixed(2)}`);
    console.log(`  总资产（净资产）: ${totalAssets.toFixed(2)}`);
    console.log('');
    
    // 2. 获取当前日期
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const weekNumber = getWeekNumber(now);
    
    console.log('2. 当前日期信息:');
    console.log(`  日期: ${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`);
    console.log(`  年度第几周: ${weekNumber}`);
    console.log(`  月份: ${month}`);
    console.log('');
    
    // 3. 更新周资产变化
    console.log('3. 更新周资产变化...');
    const weeklyFields = await getTableFields(token, weeklyTableId);
    
    const weeklyRecordFields = {
      '时间': now,
      '日期': new Date(year, month - 1, day),
      '年度第几周': weekNumber,
      '金融资产': financialAssets,
      '净资产': totalAssets
    };
    
    console.log('创建周资产记录:');
    Object.keys(weeklyRecordFields).forEach(key => {
      const value = weeklyRecordFields[key];
      if (value instanceof Date) {
        console.log(`  ${key}: ${value.toISOString().split('T')[0]}`);
      } else {
        console.log(`  ${key}: ${value}`);
      }
    });
    console.log('');
    
    try {
      const weeklyResult = await createRecord(token, weeklyTableId, weeklyRecordFields, weeklyFields);
      if (weeklyResult.code === 0) {
        console.log('  ✓ 周资产记录创建成功');
      } else {
        console.log(`  ✗ 周资产记录创建失败: ${weeklyResult.msg}`);
      }
    } catch (error) {
      console.log(`  ✗ 周资产记录创建失败: ${error.message}`);
    }
    
    console.log('');
    
    // 4. 更新月资产变化
    console.log('4. 更新月资产变化...');
    const monthlyFields = await getTableFields(token, monthlyTableId);
    
    // 获取上个月的记录来计算变化
    const monthlyRecords = await getAllRecords(token, monthlyTableId);
    const lastMonthRecord = monthlyRecords.length > 0 ? monthlyRecords[monthlyRecords.length - 1] : null;
    
    // 计算投资收益（当前金融资产 - 上个月金融资产）
    const lastMonthFinancialAssets = lastMonthRecord ? (lastMonthRecord.fields['金融资产'] || 0) : financialAssets;
    const investmentReturn = financialAssets - lastMonthFinancialAssets;
    
    // 收入、支出、收入结余、储蓄率需要用户提供或保持上个月的值
    const income = lastMonthRecord ? (lastMonthRecord.fields['收入'] || 0) : 0;
    const expense = lastMonthRecord ? (lastMonthRecord.fields['支出'] || 0) : 0;
    const incomeSurplus = income - expense;
    const savingsRate = income > 0 ? incomeSurplus / income : 0;
    
    const monthlyRecordFields = {
      '时间': now,
      '金融资产': financialAssets,
      '净资产': totalAssets,
      '收入': income,
      '支出': expense,
      '投资收益': investmentReturn
      // 收入结余和储蓄率是公式字段，会自动计算
    };
    
    console.log('创建月资产记录:');
    Object.keys(monthlyRecordFields).forEach(key => {
      const value = monthlyRecordFields[key];
      if (value instanceof Date) {
        console.log(`  ${key}: ${value.toISOString().split('T')[0]}`);
      } else if (typeof value === 'number') {
        console.log(`  ${key}: ${value.toFixed(2)}`);
      } else {
        console.log(`  ${key}: ${value}`);
      }
    });
    console.log(`  收入结余: ${incomeSurplus.toFixed(2)} (公式自动计算)`);
    console.log(`  储蓄率: ${(savingsRate * 100).toFixed(2)}% (公式自动计算)`);
    console.log('');
    
    try {
      const monthlyResult = await createRecord(token, monthlyTableId, monthlyRecordFields, monthlyFields);
      if (monthlyResult.code === 0) {
        console.log('  ✓ 月资产记录创建成功');
      } else {
        console.log(`  ✗ 月资产记录创建失败: ${monthlyResult.msg}`);
      }
    } catch (error) {
      console.log(`  ✗ 月资产记录创建失败: ${error.message}`);
    }
    
    console.log('');
    console.log('='.repeat(50));
    console.log('更新完成！');
    console.log('');
    console.log('注意:');
    console.log('- 周资产记录已创建，包含当前周的数据');
    console.log('- 月资产记录已创建，包含当前月的数据');
    console.log('- 如果收入、支出等字段需要更新，请告诉我具体数值');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

