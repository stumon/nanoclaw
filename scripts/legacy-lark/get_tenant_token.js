// 获取 tenant_access_token（自动刷新，无需手动更新）
const axios = require('axios');

const appId = 'cli_a9d97b4274f85bcd';
const appSecret = 'x57OFmr0UyF5MW7EzVWqKbaqvzKWWAMx';
const baseUrl = 'https://open.feishu.cn/open-apis';

// Token 缓存（实际使用时可以保存到文件或数据库）
let tokenCache = {
  token: null,
  expireTime: 0
};

/**
 * 获取 tenant_access_token
 * 有效期2小时，但可以自动刷新
 */
async function getTenantAccessToken() {
  // 检查缓存是否有效（提前5分钟刷新）
  const now = Date.now();
  if (tokenCache.token && tokenCache.expireTime > now + 5 * 60 * 1000) {
    return tokenCache.token;
  }
  
  try {
    const response = await axios.post(
      `${baseUrl}/auth/v3/tenant_access_token/internal`,
      {
        app_id: appId,
        app_secret: appSecret
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data.code === 0) {
      const token = response.data.tenant_access_token;
      const expire = response.data.expire || 7200; // 默认2小时
      
      // 缓存 token
      tokenCache.token = token;
      tokenCache.expireTime = now + expire * 1000;
      
      console.log(`✓ 获取 tenant_access_token 成功，有效期 ${expire} 秒`);
      return token;
    } else {
      throw new Error(`获取 token 失败: ${response.data.msg}`);
    }
  } catch (error) {
    console.error('✗ 获取 tenant_access_token 失败:', error.message);
    throw error;
  }
}

// 测试函数
async function test() {
  try {
    const token = await getTenantAccessToken();
    console.log(`Token: ${token.substring(0, 20)}...`);
    console.log(`过期时间: ${new Date(tokenCache.expireTime).toLocaleString()}`);
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

// 如果直接运行此文件，执行测试
if (require.main === module) {
  test();
}

module.exports = { getTenantAccessToken };

