/**
 * CDP 验证脚本：连接 Edge 远程调试端口，刷新页面，检查替换结果并截图。
 * node tools/cdp-check.js [--reload]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CDP_HTTP = 'http://localhost:9222';
const OUT = path.join(__dirname, '..', 'build');
const SHOULD_RELOAD = process.argv.includes('--reload');

async function main() {
  const list = await (await fetch(CDP_HTTP + '/json')).json();
  const target = list.find(t => t.type === 'page' && t.url.includes('test-page.html'));
  if (!target) {
    console.log('未找到测试页 target。可用 target:');
    for (const t of list) console.log(' -', t.type, t.url.slice(0, 90));
    process.exit(1);
  }
  console.log('目标页:', target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };

  if (SHOULD_RELOAD) {
    console.log('刷新页面...');
    await send('Page.reload', { ignoreCache: true });
    await new Promise(r => setTimeout(r, 6000));
  } else {
    await new Promise(r => setTimeout(r, 3000));
  }

  const evalRes = await send('Runtime.evaluate', {
    expression: `(() => {
      const words = document.querySelectorAll('.le-word');
      const badTitle = Array.from(words).filter(s => s.title && s.title !== '' && s.title.includes(s.textContent.slice(0,4)));
      const selfCheck = document.getElementById('result');
      const broken = document.body.innerText.match(/[A-Za-z][\\u4e00-\\u9fff]|[\\u4e00-\\u9fff][A-Za-z]/g);
      return JSON.stringify({
        count: words.length,
        samples: Array.from(words).slice(0, 15).map(s => s.textContent + '(' + (s.title || '-') + ')'),
        selfCheck: selfCheck ? selfCheck.textContent : null,
        mixedCnEn: broken ? Array.from(new Set(broken)).slice(0, 10) : [],
        hasBrokenWord: /(?:帮助|购物车)[A-Za-z]|[A-Za-z](?:帮助|购物车)/.test(document.body.innerText)
      });
    })()`,
    returnByValue: true
  });
  const info = JSON.parse(evalRes.result.value);
  console.log('替换词数量:', info.count);
  console.log('示例:', info.samples.join('  '));
  console.log('自检:', info.selfCheck);
  console.log('中英混杂片段:', JSON.stringify(info.mixedCnEn));
  console.log('含破碎词(帮助/购物车):', info.hasBrokenWord);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, 'cdp-verify.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('截图已保存:', file, fs.statSync(file).size, 'bytes');

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
