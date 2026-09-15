const { _electron: electron } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { digest } = require('../src/main/library.cjs');
const output = path.resolve('.test-output');
let app;
(async () => {
  await fs.mkdir(output, { recursive: true });
  const base = await fs.mkdtemp(path.join(output, 'ui-'));
  const photos = path.join(base, '测试照片'); const data = path.join(base, 'records');
  await fs.mkdir(photos);
  for (let i = 0; i < 25; i++) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1100"><rect width="1600" height="1100" fill="#c6d5cb"/><circle cx="1120" cy="260" r="100" fill="#f4ebce"/><path d="M0 700 370 370 730 650 1150 390 1600 730v370H0Z" fill="#7e9d85"/><path d="M0 840 480 580 1050 830 1450 660 1600 820v280H0Z" fill="#466c5b"/><path d="M700 1100 860 820 1050 830 880 1100Z" fill="#b3c9c5"/><text x="65" y="1020" font-family="sans-serif" font-size="25" fill="#fff">TEST PHOTO · ${String(i + 1).padStart(2, '0')}</text></svg>`;
    let image = sharp(Buffer.from(svg));
    if (i === 0) { const d = new Date(); image = image.withExifMerge({ IFD2: { DateTimeOriginal: `2023:${String(d.getMonth() + 1).padStart(2, '0')}:${String(d.getDate()).padStart(2, '0')} 12:00:00` } }); }
    await image.jpeg().toFile(path.join(photos, `${String(i).padStart(2, '0')}-test.jpg`));
  }
  let heic = false;
  if (process.platform === 'darwin') {
    try { await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'heic', path.join(photos, '00-test.jpg'), '--out', path.join(photos, '01-heic.heic')]); heic = true; } catch (e) { console.log('HEIC fixture unavailable:', e.message); }
  }
  await fs.writeFile(path.join(photos, '02-broken.png'), 'intentionally invalid test fixture');
  const originals = await Promise.all((await fs.readdir(photos)).map(async f => [f, await digest(path.join(photos, f))]));
  const launch = async () => {
    app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, TWENTY_TEST_DATA: data, ELECTRON_ENABLE_LOGGING: '1' } });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', e => { throw e; });
    await page.locator('#busy').waitFor({ state: 'hidden' });
    return page;
  };
  let page = await launch();
  await page.screenshot({ animations: 'disabled', path: path.join(output, '01-welcome.png') });
  await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, photos);
  await page.getByRole('button', { name: '选择照片文件夹', exact: true }).click();
  await page.locator('#busy').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '开始今天的整理', exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: path.join(output, '02-home.png') });
  assert.ok((await page.locator('.memory-note').textContent()).includes('年前的今天'));
  await page.getByRole('button', { name: '开始今天的整理', exact: true }).click();
  await page.locator('.photo-area.loaded').waitFor();
  await page.screenshot({ animations: 'disabled', path: path.join(output, '03-review.png') });
  await page.keyboard.press('ArrowLeft'); await page.locator('.review-progress b').filter({ hasText: /^2$/ }).waitFor();
  await page.getByRole('button', { name: /撤销上一步/ }).click();
  await page.waitForFunction(() => document.querySelector('.review-progress b')?.textContent === '1');
  await page.locator('.photo-area.loaded').waitFor(); await page.keyboard.press('ArrowRight');
  await page.locator('.review-progress b').filter({ hasText: /^2$/ }).waitFor();
  await app.close(); app = null;
  page = await launch();
  await page.getByRole('button', { name: /继续今天的整理 · 1/ }).click();
  let observedHEIC = false, observedFailure = false;
  for (let i = 1; i < 20; i++) {
    await page.waitForFunction(() => document.querySelector('.photo-area.loaded') || document.querySelector('.photo-error'));
    const failed = await page.locator('.photo-error').count();
    const name = await page.locator('.photo-name').textContent();
    if (/heic/.test(name)) { assert.equal(failed, 0, 'HEIC should preview on macOS'); observedHEIC = true; }
    if (/broken/.test(name)) { assert.equal(failed, 1); observedFailure = true; }
    await page.keyboard.press(failed ? 'Space' : ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'][i % 4]);
    if (i < 19) await page.waitForFunction(n => document.querySelector('.review-progress b')?.textContent === String(n), i + 2);
  }
  await page.getByRole('button', { name: '确认本次整理', exact: true }).waitFor();
  assert.ok(observedFailure); if (heic) assert.ok(observedHEIC);
  for (const [f, h] of originals) assert.equal(await digest(path.join(photos, f)), h, 'Original must remain unchanged before confirmation');
  await page.screenshot({ animations: 'disabled', path: path.join(output, '04-complete-pending.png') });
  await page.getByRole('button', { name: '查看今天的结果', exact: true }).click();
  const selects = page.locator('select[data-revise]'); await selects.first().selectOption('favorite');
  await page.locator('#busy').waitFor({ state: 'hidden' });
  await page.screenshot({ animations: 'disabled', path: path.join(output, '05-results.png') });
  await page.getByRole('button', { name: '看好了', exact: true }).click();
  await page.getByRole('button', { name: '确认本次整理', exact: true }).click();
  await page.getByRole('button', { name: '今天就到这里', exact: true }).waitFor();
  await page.screenshot({ animations: 'disabled', path: path.join(output, '06-confirmed.png') });
  const saved = JSON.parse(await fs.readFile(path.join(data, 'records.json'), 'utf8'));
  const lib = saved.libraries[saved.active]; assert.equal(lib.history[0].choices.length, 20); assert.equal(lib.draft, null);
  await app.close(); app = null; page = await launch();
  await page.getByRole('button', { name: '查看今天的结果', exact: true }).click();
  await page.getByRole('button', { name: '撤销本次整理', exact: true }).click();
  await page.getByRole('button', { name: '恢复原位', exact: true }).click();
  await page.locator('#busy').waitFor({ state: 'hidden' });
  for (const [f, h] of originals) assert.equal(await digest(path.join(photos, f)), h, 'Undo must restore exact original bytes');
  await page.getByRole('button', { name: /继续今天的整理 · 0/ }).waitFor();
  await app.close(); app = null;
  await fs.writeFile(path.join(output, 'ui-result.json'), JSON.stringify({ passed: true, photos: originals.length, heicTested: observedHEIC, unreadableTested: observedFailure, output: base }, null, 2));
  console.log('PASS: real Electron UI, folder selection, EXIF, preview, HEIC, unreadable file, keyboard, undo, restart resume, 20-photo limit, revise, confirm, restart persistence, restore byte verification.');
  console.log('Evidence:', output);
})().catch(async e => { console.error(e); if (app) { try { const p = await app.firstWindow(); await p.screenshot({ path: path.join(output, 'failure.png') }); console.error(await p.locator('body').innerText()); } catch {} await app.close().catch(() => {}); } process.exitCode = 1; });
