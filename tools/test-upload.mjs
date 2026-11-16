// 验证 /upload 保留中文文件名（用 \u 转义，避免控制台编码干扰）
const NAME = '\u6d4b\u8bd5\u6587\u6863.docx'; // 测试文档.docx
const body = JSON.stringify({ name: NAME, dataBase64: Buffer.from('PK-test').toString('base64') });
const r = await fetch('http://127.0.0.1:62554/dsh-paper-dual/upload', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
});
const j = await r.json();
console.log('status', r.status, 'ok', j.ok);
console.log('path:', j.path);
console.log('name-kept:', String(j.path || '').includes('\u6d4b\u8bd5\u6587\u6863'));
