// 为月资产变化表格添加新字段
const axios = require('axios');
const { getAccessToken } = require('./get_token');

const baseId = 'WlHUbyiobawU1GssgoXcdfE0noh';
const monthlyTableId = 'tblyGhh4iegb5CiD';     // 月资产变化表格
const baseUrl = 'https://open.feishu.cn/open-apis';

// 需要添加的字段列表（区分A股个股和场内基金ETF）
const fieldsToAdd = [
  { field_name: '月份', type: 1 },
  { field_name: '金融资产', type: 2, description: { text: 'A股+场内基金+美股+基金（不含现金）' } },
  { field_name: '总资产', type: 2, description: { text: '金融资产+现金' } },
  { field_name: 'A股金额', type: 2, description: { text: 'A股个股市值' } },
  { field_name: '场内基金金额', type: 2, description: { text: '场内ETF市值' } },
  { field_name: '美股金额', type: 2, description: { text: '美股总市值(CNY)' } },
  { field_name: '基金金额', type: 2, description: { text: '场外基金（支付宝+招商银行）' } },
  { field_name: '现金金额', type: 2, description: { text: '现金+货币基金总额' } },
  { field_name: '总资产变化', type: 2, description: { text: '相比上月变化金额' } },
  { field_name: '总资产变化率', type: 1, description: { text: '相比上月变化百分比' } },
];

async function addField(token, field) {
  try {
    const response = await axios.post(
      `${baseUrl}/bitable/v1/apps/${baseId}/tables/${monthlyTableId}/fields`,
      field,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return { success: true, name: field.field_name };
  } catch (error) {
    if (error.response && error.response.data.code === 1254043) {
      return { success: true, name: field.field_name, exists: true };
    }
    return { success: false, name: field.field_name, error: error.response?.data?.msg || error.message };
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('为月资产变化表格添加字段');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    const token = await getAccessToken();
    console.log('✓ Token 获取成功');
    console.log('');
    
    console.log('开始添加字段...');
    console.log('');
    
    for (const field of fieldsToAdd) {
      const result = await addField(token, field);
      if (result.success) {
        if (result.exists) {
          console.log(`   ⚠ ${result.name} (已存在，跳过)`);
        } else {
          console.log(`   ✓ ${result.name} (已添加)`);
        }
      } else {
        console.log(`   ✗ ${result.name} (失败: ${result.error})`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    
    console.log('');
    console.log('='.repeat(60));
    console.log('字段添加完成！');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('✗ 操作失败:', error.message);
    if (error.response) {
      console.error('错误详情:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

main();
