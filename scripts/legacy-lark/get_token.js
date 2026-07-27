// 统一的 Token 获取函数
// 优先使用 tenant_access_token（自动刷新），如果权限不足则使用 user_access_token
const axios = require('axios');
const { getTenantAccessToken } = require('./get_tenant_token');

const appId = 'cli_a9d97b4274f85bcd';
const appSecret = 'x57OFmr0UyF5MW7EzVWqKbaqvzKWWAMx';
const baseUrl = 'https://open.feishu.cn/open-apis';

// 可选：通过环境变量 FEISHU_USER_TOKEN 指定 user_access_token（有效期2小时）
// 未设置时自动使用 tenant_access_token（自动刷新，推荐）
const USER_ACCESS_TOKEN = process.env.FEISHU_USER_TOKEN || '';

async function getAccessToken() {
  if (USER_ACCESS_TOKEN) {
    console.log('使用 user_access_token（需要手动更新，有效期2小时）');
    return USER_ACCESS_TOKEN;
  }

  try {
    const token = await getTenantAccessToken();
    return token;
  } catch (error) {
    console.error('获取 tenant_access_token 失败，请检查 App ID 和 App Secret');
    throw error;
  }
}

module.exports = { getAccessToken };

