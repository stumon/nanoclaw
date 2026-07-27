// 获取 user_access_token（需要用户授权，但权限更广）
// 注意：这个 token 需要手动获取，不能自动刷新
// 可以通过飞书开发者后台或 OAuth 流程获取

const axios = require('axios');

const appId = 'cli_a9d97b4274f85bcd';
const appSecret = 'x57OFmr0UyF5MW7EzVWqKbaqvzKWWAMx';
const baseUrl = 'https://open.feishu.cn/open-apis';

/**
 * 获取 user_access_token
 * 注意：这个方法需要用户授权，不能自动获取
 * 需要通过 OAuth 流程或飞书开发者后台手动获取
 * 
 * @param {string} code - OAuth 授权码（从 OAuth 回调中获取）
 * @returns {Promise<string>} user_access_token
 */
async function getUserAccessTokenByCode(code) {
  try {
    const response = await axios.post(
      `${baseUrl}/authen/v1/oidc/access_token`,
      {
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code: code
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data.code === 0) {
      return response.data.data.access_token;
    } else {
      throw new Error(`获取 token 失败: ${response.data.msg}`);
    }
  } catch (error) {
    console.error('✗ 获取 user_access_token 失败:', error.message);
    throw error;
  }
}

/**
 * 刷新 user_access_token
 * @param {string} refreshToken - 刷新 token
 * @returns {Promise<string>} 新的 user_access_token
 */
async function refreshUserAccessToken(refreshToken) {
  try {
    const response = await axios.post(
      `${baseUrl}/authen/v1/oidc/refresh_access_token`,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: appId,
        client_secret: appSecret
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    if (response.data.code === 0) {
      return response.data.data.access_token;
    } else {
      throw new Error(`刷新 token 失败: ${response.data.msg}`);
    }
  } catch (error) {
    console.error('✗ 刷新 user_access_token 失败:', error.message);
    throw error;
  }
}

module.exports = { getUserAccessTokenByCode, refreshUserAccessToken };

