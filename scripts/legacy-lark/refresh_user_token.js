// 获取新的 user_access_token 的辅助脚本
// 
// 使用方法：
// 1. 访问授权链接获取 code
// 2. 运行此脚本：node refresh_user_token.js <code>
// 3. 复制输出的 token 到 get_token.js 或设置环境变量

const axios = require('axios');

const appId = 'cli_a9d97b4274f85bcd';
const appSecret = 'x57OFmr0UyF5MW7EzVWqKbaqvzKWWAMx';
const baseUrl = 'https://open.feishu.cn/open-apis';
const redirectUri = 'https://example.com/callback'; // 回调地址

async function getAccessTokenByCode(code) {
  try {
    const response = await axios.post(
      `${baseUrl}/authen/v1/oidc/access_token`,
      {
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code: code,
        redirect_uri: redirectUri
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('API 错误:', error.response.data);
    }
    throw error;
  }
}

async function main() {
  const code = process.argv[2];
  
  if (!code) {
    console.log('='.repeat(60));
    console.log('获取飞书 user_access_token 的步骤：');
    console.log('='.repeat(60));
    console.log('');
    console.log('步骤 1: 访问以下授权链接（在浏览器中打开）：');
    console.log('');
    const authUrl = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=bitable:app`;
    console.log(authUrl);
    console.log('');
    console.log('步骤 2: 登录飞书账号并授权');
    console.log('');
    console.log('步骤 3: 从重定向的 URL 中复制 code 参数');
    console.log('   例如：https://example.com/callback?code=xxx');
    console.log('   复制 xxx 部分');
    console.log('');
    console.log('步骤 4: 运行此脚本并传入 code：');
    console.log('   node refresh_user_token.js <code>');
    console.log('');
    console.log('='.repeat(60));
    console.log('');
    console.log('或者，直接使用飞书开发者后台的 API 调试器：');
    console.log('https://open.feishu.cn/api-explorer/cli_a9d97b4274f85bcd');
    console.log('');
    console.log('在 API 调试器中：');
    console.log('1. 选择任意 bitable API');
    console.log('2. 点击「获取 access_token」');
    console.log('3. 选择「user_access_token」');
    console.log('4. 完成授权后，复制 token');
    console.log('5. 设置环境变量：export FEISHU_USER_TOKEN=\'你的token\'');
    console.log('');
    return;
  }
  
  console.log('使用 code 获取 access_token...');
  console.log('');
  
  try {
    const result = await getAccessTokenByCode(code);
    
    if (result.code === 0) {
      console.log('✓ 获取成功！');
      console.log('');
      console.log('access_token:', result.data.access_token);
      console.log('');
      console.log('refresh_token:', result.data.refresh_token);
      console.log('');
      console.log('有效期:', result.data.expires_in, '秒');
      console.log('');
      console.log('='.repeat(60));
      console.log('使用方法：');
      console.log('');
      console.log('方法 1: 设置环境变量');
      console.log(`export FEISHU_USER_TOKEN='${result.data.access_token}'`);
      console.log('');
      console.log('方法 2: 更新 get_token.js 文件中的 USER_ACCESS_TOKEN');
      console.log('');
    } else {
      console.log('✗ 获取失败:', result.msg);
      console.log('完整响应:', JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error('✗ 获取失败:', error.message);
  }
}

main();


