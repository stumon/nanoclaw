// 验证周资产和月资产更新结果
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const baseUrl = 'https://open.feishu.cn/open-apis';

const weeklyTableId = 'tbllsUyyZ23A4Kxx';
const monthlyTableId = 'tblyGhh4iegb5CiD';

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

function formatDate(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

async function main() {
  console.log('验证周资产和月资产更新结果...');
  console.log('');
  
  try {
    // 自动获取 token（优先使用 tenant_access_token，如果权限不足可使用 user_access_token）
    const token = await getAccessToken();
    
    // 1. 查看周资产记录
    console.log('1. 周资产变化记录:');
    const weeklyRecords = await getAllRecords(token, weeklyTableId);
    console.log(`共 ${weeklyRecords.length} 条记录`);
    console.log('');
    
    if (weeklyRecords.length > 0) {
      // 显示最新的几条记录
      const recentRecords = weeklyRecords.slice(-3);
      recentRecords.forEach((record, index) => {
        const fields = record.fields;
        console.log(`记录 ${weeklyRecords.length - recentRecords.length + index + 1}:`);
        console.log(`  日期: ${formatDate(fields['日期'])}`);
        console.log(`  时间: ${formatDate(fields['时间'])}`);
        console.log(`  年度第几周: ${fields['年度第几周'] || 'N/A'}`);
        console.log(`  金融资产: ${fields['金融资产'] || 'N/A'}`);
        console.log(`  净资产: ${fields['净资产'] || 'N/A'}`);
        console.log('');
      });
    }
    
    // 2. 查看月资产记录
    console.log('2. 月资产变化记录:');
    const monthlyRecords = await getAllRecords(token, monthlyTableId);
    console.log(`共 ${monthlyRecords.length} 条记录`);
    console.log('');
    
    if (monthlyRecords.length > 0) {
      // 显示最新的几条记录
      const recentRecords = monthlyRecords.slice(-3);
      recentRecords.forEach((record, index) => {
        const fields = record.fields;
        console.log(`记录 ${monthlyRecords.length - recentRecords.length + index + 1}:`);
        console.log(`  时间: ${formatDate(fields['时间'])}`);
        console.log(`  金融资产: ${fields['金融资产'] || 'N/A'}`);
        console.log(`  净资产: ${fields['净资产'] || 'N/A'}`);
        console.log(`  收入: ${fields['收入'] || 'N/A'}`);
        console.log(`  支出: ${fields['支出'] || 'N/A'}`);
        console.log(`  收入结余: ${fields['收入结余'] || 'N/A'}`);
        console.log(`  储蓄率: ${fields['储蓄率'] || 'N/A'}`);
        console.log(`  投资收益: ${fields['投资收益'] || 'N/A'}`);
        console.log('');
      });
    }
    
    console.log('='.repeat(50));
    console.log('验证完成！');
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误信息:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();

