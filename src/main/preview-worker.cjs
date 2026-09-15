const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
sharp.cache({ memory: 32, files: 0, items: 16 });
sharp.concurrency(1);
parentPort.on('message', async ({ id, source, destination }) => {
  const tmp = destination + '.tmp.jpg';
  const converted = destination + '.converted.jpg';
  try {
    const resize = input => sharp(input, { limitInputPixels: 100000000, animated: false }).rotate().resize({ width: 1800, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 });
    try { await resize(source).toFile(tmp); }
    catch (error) {
      if (!/\.hei[cf]$/i.test(source)) throw error;
      if (process.platform === 'darwin') {
        await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '1800', source, '--out', converted], { timeout: 45000, maxBuffer: 1024 * 1024 });
        await resize(converted).toFile(tmp);
      } else {
        if ((await fs.stat(source)).size > 40 * 1024 * 1024) throw new Error('HEIC 文件过大，可先转换为 JPEG 后重试。');
        const decode = require('heic-decode');
        const decoded = await decode({ buffer: await fs.readFile(source) });
        if (decoded.width * decoded.height > 100000000) throw new Error('照片像素过大。');
        await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).resize({ width: 1800, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toFile(tmp);
      }
    }
    await fs.rename(tmp, destination);
    parentPort.postMessage({ id });
  } catch (e) { parentPort.postMessage({ id, error: '这张照片暂时无法预览。可以稍后再决定。' }); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); await fs.rm(converted, { force: true }).catch(() => {}); }
});
