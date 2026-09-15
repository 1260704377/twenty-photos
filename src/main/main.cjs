const { app, BrowserWindow, ipcMain, dialog, protocol, session, shell, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { Library, hash } = require('./library.cjs');
app.setName('20张');
if (process.env.TWENTY_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.TWENTY_TEST_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'twenty', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const singleton = app.requestSingleInstanceLock();
let window, library, worker, previewSequence = 0, operation = false, startupError;
let previewQueue = Promise.resolve();
const jobs = new Map(); const inflight = new Map();
const dataDir = app.getPath('userData'); const cacheDir = path.join(app.getPath('cache'), '20zhang-previews');
if (!singleton) app.quit();
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
function progress(value) { if (window && !window.isDestroyed()) window.webContents.send('progress', value); }
function spawnWorker() {
  const w = new Worker(path.join(__dirname, 'preview-worker.cjs'));
  w.on('message', ({ id, error }) => { const job = jobs.get(id); if (job) { jobs.delete(id); error ? job.reject(new Error(error)) : job.resolve(); } });
  const rejectAll = () => { for (const job of jobs.values()) job.reject(new Error('照片解码中断，可以稍后重试。')); jobs.clear(); if (worker === w) worker = null; };
  w.on('error', rejectAll); w.on('exit', rejectAll); return w;
}
async function preview(id) {
  const { file, photo } = await library.photoPath(id);
  const key = hash(file + photo.signature); const destination = path.join(cacheDir, key + '.jpg');
  try { await fs.access(destination); return destination; } catch {}
  if (inflight.has(key)) return inflight.get(key);
  const result = previewQueue.catch(() => {}).then(async () => {
    worker ??= spawnWorker();
    const id = ++previewSequence;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker?.terminate(); reject(new Error('照片预览超时，可以稍后再决定。')); }, 60000);
      jobs.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: e => { clearTimeout(timer); reject(e); } });
      worker.postMessage({ id, source: file, destination });
    });
    return destination;
  }).finally(() => inflight.delete(key));
  inflight.set(key, result); previewQueue = result; return result;
}
function humanError(error) {
  const code = error.code;
  if (['EACCES', 'EPERM'].includes(code)) return '无法访问这个文件夹。请检查文件夹权限，或在系统设置中允许「20张」访问照片所在位置。';
  if (code === 'ENOENT') return '找不到照片或文件夹。请重新连接原磁盘，然后重试；未完成的操作已经记录。';
  if (code === 'ENOSPC') return '磁盘空间不足。请腾出一些空间后重试；现有照片仍保留。';
  if (code === 'EEXIST') return '目标位置已有同名文件，程序没有覆盖它。请检查「20张整理」文件夹，然后重试或恢复原位。';
  if (code === 'EROFS') return '这个磁盘是只读的，无法保存文件整理。请使用可写的照片文件夹。';
  return error.message || '这一步没有完成，请重试。';
}
function handle(name, action, exclusive = true) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || !event.senderFrame.url.startsWith('twenty://app/')) return { ok: false, error: '请求被拒绝。' };
    if (startupError) return { ok: false, error: startupError };
    if (exclusive && operation) return { ok: false, error: '正在保存上一步，请稍等。' };
    if (exclusive) operation = true;
    try { return { ok: true, value: await action(...args) }; }
    catch (e) {
      if (exclusive) { try { await library.init(); } catch (e) { startupError = humanError(e); } }
      return { ok: false, error: humanError(e), state: library?.state ? library.snapshot() : null };
    } finally { if (exclusive) operation = false; }
  });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 800, minHeight: 700,
    title: '20张', backgroundColor: '#f7f7f2', autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (operation) { event.preventDefault(); progress({ phase: 'busy' }); } });
  await window.loadURL('twenty://app/index.html');
}
if (singleton) app.whenReady().then(async () => {
  await fs.mkdir(cacheDir, { recursive: true });
  // Cached previews are disposable, limited to roughly 300 MB across launches.
  const cached = await fs.readdir(cacheDir);
  let bytes = 0;
  for (const file of cached.reverse()) { const p = path.join(cacheDir, file); try { bytes += (await fs.stat(p)).size; if (bytes > 300 * 1024 * 1024) await fs.rm(p); } catch {} }
  library = new Library(dataDir, { onProgress: progress });
  try { await library.init(); } catch (e) { startupError = humanError(e); }
  session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
  protocol.handle('twenty', async request => {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET') return new Response('', { status: 405 });
      if (url.hostname === 'photo' && /^\/[a-f0-9]{64}$/.test(url.pathname)) {
        const file = await preview(url.pathname.slice(1));
        return new Response(await fs.readFile(file), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' } });
      }
      const files = { '/index.html': 'text/html', '/app.js': 'application/javascript', '/style.css': 'text/css' };
      if (url.hostname !== 'app' || !files[url.pathname]) return new Response('', { status: 404 });
      return new Response(await fs.readFile(path.join(__dirname, '../renderer', url.pathname.slice(1))), { headers: { 'Content-Type': files[url.pathname], 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' twenty:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    } catch { return new Response('Preview unavailable', { status: 404 }); }
  });
  handle('load', async () => { await library.scan(); return library.snapshot(); });
  handle('state', () => library.snapshot(), false);
  handle('choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '选择一个照片文件夹', buttonLabel: '从这里开始', properties: ['openDirectory'] });
    if (result.canceled) return library.snapshot();
    return library.choose(result.filePaths[0]);
  });
  handle('start', () => library.start());
  handle('decide', (id, status) => library.decide(id, status));
  handle('undo', () => library.undoStep());
  handle('revise', (id, status) => library.revise(id, status));
  handle('confirm', () => library.confirm());
  handle('discard', () => library.discard());
  handle('restore', () => library.restore());
  handle('show-folder', async () => { if (library.lib) { const error = await shell.openPath(library.lib.root); if (error) throw new Error(error); } return library.snapshot(); });
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([
    { label: '20张', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]) : null);
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(e => { dialog.showErrorBox('20张暂时无法启动', humanError(e)); app.quit(); });
app.on('window-all-closed', () => { worker?.terminate(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => { if (operation) event.preventDefault(); else worker?.terminate(); });
