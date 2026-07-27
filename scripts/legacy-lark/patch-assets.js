#!/usr/bin/env node
/**
 * Safely patches the data variables in update_all_assets.js from a JSON file.
 *
 * Usage:
 *   node patch-assets.js <json-file>
 *   node patch-assets.js --data '<json-string>'
 *
 * The JSON should contain only the platforms you want to update.
 * Other platforms remain unchanged.
 *
 * JSON format:
 * {
 *   "galaxy": {                     // 中国银河证券
 *     "holdings": [
 *       { "name": "...", "code": "601318", "quantity": 1100, "price": 65.29, "assetType": "A股" }
 *     ],
 *     "cash": 49545.98
 *   },
 *   "ibkr": {                       // 盈透证券
 *     "holdings": [
 *       { "name": "META", "code": "META", "quantity": 2, "priceUSD": 663.98, "assetType": "美股" }
 *     ],
 *     "cash": 1800.00
 *   },
 *   "huatai": {                     // 华泰证券
 *     "holdings": [
 *       { "name": "恒生医药ETF", "code": "159892", "quantity": 11900, "price": 0.828, "assetType": "场内基金" }
 *     ]
 *   },
 *   "chuancai": {                   // 川财证券
 *     "holdings": [ ... ],
 *     "cash": 3996.28
 *   },
 *   "alipay": {                     // 支付宝
 *     "cash": 2904.73,
 *     "fund": 48635.69
 *   },
 *   "yunShanFu": 118385.10,         // 云闪付
 *   "zhaoShang": 525050.9           // 招商银行基金
 * }
 */

const fs = require('fs');
const path = require('path');

const TARGET_FILE = path.join(__dirname, 'update_all_assets.js');

function formatHolding(h) {
  const fields = [];
  fields.push(`name: '${h.name}'`);
  fields.push(`code: '${h.code || ''}'`);
  fields.push(`quantity: ${h.quantity}`);
  if (h.priceUSD !== undefined) {
    fields.push(`priceUSD: ${h.priceUSD}`);
  } else {
    fields.push(`price: ${h.price}`);
  }
  fields.push(`assetType: '${h.assetType}'`);
  return `  { ${fields.join(', ')} }`;
}

function formatHoldingsArray(holdings) {
  return '[\n' + holdings.map(formatHolding).join(',\n') + ',\n]';
}

function replaceVariable(content, varName, newValue) {
  // Match: const varName = VALUE;  or  const varName = VALUE;\n
  // VALUE can be a number, array [...], or object {...}
  const patterns = [
    // Array: const varName = [\n...\n];
    new RegExp(
      `(const ${varName} = )\\[[\\s\\S]*?\\];`,
      'm'
    ),
    // Object: const varName = {\n...\n};
    new RegExp(
      `(const ${varName} = )\\{[\\s\\S]*?\\};`,
      'm'
    ),
    // Simple value: const varName = 12345.67;
    new RegExp(
      `(const ${varName} = )[^;]+;`,
      'm'
    ),
  ];

  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, `$1${newValue};`);
    }
  }
  console.warn(`  ⚠ Variable "${varName}" not found in file`);
  return content;
}

function main() {
  let jsonInput;

  if (process.argv[2] === '--data') {
    jsonInput = process.argv[3];
  } else if (process.argv[2]) {
    const jsonPath = path.resolve(process.argv[2]);
    jsonInput = fs.readFileSync(jsonPath, 'utf-8');
  } else {
    console.error('Usage: node patch-assets.js <json-file>');
    console.error('       node patch-assets.js --data \'{"galaxy": {...}}\'');
    process.exit(1);
  }

  const data = JSON.parse(jsonInput);
  let content = fs.readFileSync(TARGET_FILE, 'utf-8');
  let patchCount = 0;

  if (data.galaxy) {
    if (data.galaxy.holdings) {
      content = replaceVariable(content, 'galaxyHoldings', formatHoldingsArray(data.galaxy.holdings));
      patchCount++;
    }
    if (data.galaxy.cash !== undefined) {
      content = replaceVariable(content, 'galaxyCash', String(data.galaxy.cash));
      patchCount++;
    }
  }

  if (data.ibkr) {
    if (data.ibkr.holdings) {
      content = replaceVariable(content, 'ibkrHoldings', formatHoldingsArray(data.ibkr.holdings));
      patchCount++;
    }
    if (data.ibkr.cash !== undefined) {
      content = replaceVariable(content, 'ibkrCash', String(data.ibkr.cash));
      patchCount++;
    }
  }

  if (data.huatai) {
    if (data.huatai.holdings) {
      content = replaceVariable(content, 'huataiHoldings', formatHoldingsArray(data.huatai.holdings));
      patchCount++;
    }
  }

  if (data.chuancai) {
    if (data.chuancai.holdings) {
      content = replaceVariable(content, 'chuancaiHoldings', formatHoldingsArray(data.chuancai.holdings));
      patchCount++;
    }
    if (data.chuancai.cash !== undefined) {
      content = replaceVariable(content, 'chuancaiCash', String(data.chuancai.cash));
      patchCount++;
    }
  }

  if (data.alipay) {
    const alipayObj = `{\n  cash: ${data.alipay.cash},  // 余额宝\n  fund: ${data.alipay.fund},  // 基金\n}`;
    content = replaceVariable(content, 'alipayData', alipayObj);
    patchCount++;
  }

  if (data.yunShanFu !== undefined) {
    content = replaceVariable(content, 'yunShanFuCash', String(data.yunShanFu));
    patchCount++;
  }

  if (data.zhaoShang !== undefined) {
    content = replaceVariable(content, 'zhaoShangFund', String(data.zhaoShang));
    patchCount++;
  }

  fs.writeFileSync(TARGET_FILE, content);
  console.log(`✓ Patched ${patchCount} variables in update_all_assets.js`);
  console.log(`  Updated platforms: ${Object.keys(data).join(', ')}`);
}

main();
