const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
let app;
(async () => {
  const output = path.resolve('.test-output');
  const fixture = JSON.parse(await fs.readFile(path.join(output, 'ui-result.json'), 'utf8'));
  const executablePath = path.resolve('release/mac-arm64/20张.app/Contents/MacOS/20张');
  app = await electron.launch({ executablePath });
  const page = await app.firstWindow(); await page.locator('#busy').waitFor({ state: 'hidden' });
  assert.equal(await page.title(), '20张 · 慢慢整理，好好留住');
  assert.equal(await page.locator('#notice:not([hidden])').count(), 0);
  assert.equal(await page.getByRole('button', { name: '选择照片文件夹', exact: true }).count(), 1);
  const result = await app.evaluate(async ({ app }, { fixtureRoot, output }) => {
    const { Worker } = process.getBuiltinModule('node:worker_threads');
    const fs = process.getBuiltinModule('node:fs/promises'); const path = process.getBuiltinModule('node:path');
    const worker = new Worker(path.join(app.getAppPath(), 'src/main/preview-worker.cjs'));
    try {
      const results = [];
      for (const [i, file] of ['00-test.jpg', '01-heic.heic'].entries()) {
        const destination = path.join(output, `packaged-${i}.jpg`);
        await new Promise((resolve, reject) => {
          worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve()); worker.once('error', reject);
          worker.postMessage({ id: i, source: path.join(fixtureRoot, '测试照片', file), destination });
        });
        results.push((await fs.stat(destination)).size);
      }
      return { sizes: results, packaged: app.isPackaged, version: app.getVersion(), appPath: app.getAppPath() };
    } finally { await worker.terminate(); }
  }, { fixtureRoot: fixture.output, output });
  assert.equal(result.packaged, true); assert.ok(result.sizes.every(n => n > 100));
  await page.screenshot({ animations: 'disabled', path: path.join(output, '07-packaged-app.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700));
  await page.screenshot({ animations: 'disabled', path: path.join(output, '08-small-window.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await fs.writeFile(path.join(output, 'package-result.json'), JSON.stringify({ passed: true, ...result }, null, 2));
  console.log('PASS: packaged Mac application starts, sandboxed UI loads, bundled worker decodes JPEG and HEIC; minimum-width layout fits.');
  await app.close(); app = null;
})().catch(async e => { console.error(e); if (app) await app.close().catch(() => {}); process.exitCode = 1; });
