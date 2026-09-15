const fs = require('node:fs/promises');
const { createReadStream, constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const exifr = require('exifr');
const MANAGED = '20张整理';
const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.tif', '.tiff', '.avif', '.bmp']);
const STATUSES = new Set(['keep', 'favorite', 'delete', 'later']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const previousDay = key => { const d = new Date(`${key}T12:00:00`); d.setDate(d.getDate() - 1); return dayKey(d); };
const signature = stat => `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
const exists = async p => fs.lstat(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
async function digest(file) { const h = crypto.createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
function within(root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('文件路径超出了所选文件夹。');
  return target;
}
async function safePath(root, relative, makeParents = false) {
  const target = within(root, relative);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('原文件夹已改变，请重新连接原文件夹。');
  let current = root;
  for (const component of path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (makeParents) await fs.mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('为保护照片，不能通过快捷方式或符号链接操作文件。');
  }
  const st = await exists(target);
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error('照片路径发生变化，已停止操作。');
  return target;
}
async function syncDirectory(directory) {
  try { const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
  catch (e) { if (process.platform !== 'win32' && !['EINVAL', 'ENOTSUP', 'EISDIR'].includes(e.code)) throw e; }
}
async function verify(file, expected) {
  const st = await exists(file);
  if (!st) return false;
  if (!st.isFile() || st.isSymbolicLink() || st.size !== expected.size || await digest(file) !== expected.sha256) {
    throw new Error(`文件内容已变化，已保留现有文件并停止操作：${path.basename(file)}`);
  }
  return true;
}
// Recoverable move: exclusive destination, byte verification, then remove the old
// directory entry. A persisted journal always precedes this operation. Never overwrite.
async function safeMove(root, from, to, expected) {
  const source = await safePath(root, from);
  const destination = await safePath(root, to, true);
  const sourceExists = await verify(source, expected);
  const destinationExists = await verify(destination, expected);
  if (!sourceExists && !destinationExists) throw new Error(`找不到照片，请重新连接原磁盘：${path.basename(source)}`);
  if (!destinationExists) {
    try { await fs.link(source, destination); }
    catch (e) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)) throw e;
      const originalStat = await fs.stat(source);
      await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
      await fs.utimes(destination, originalStat.atime, originalStat.mtime);
    }
    const h = await fs.open(destination, 'r');
    try { await h.sync(); } finally { await h.close(); }
  }
  await verify(destination, expected);
  await syncDirectory(path.dirname(destination));
  if (sourceExists) {
    // Check again immediately before removing the source name.
    await verify(await safePath(root, from), expected);
    await fs.unlink(source);
    await syncDirectory(path.dirname(source));
  }
}
function captureDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}
function anniversary(photo, now) {
  const date = photo.taken;
  if (!date || date.year >= now.getFullYear()) return false;
  return date.month === now.getMonth() + 1 && date.day === now.getDate();
}
class Library {
  constructor(dataDir, { now = () => new Date(), onProgress = () => {} } = {}) {
    this.dataDir = dataDir; this.now = now; this.onProgress = onProgress;
    this.file = path.join(dataDir, 'records.json'); this.photos = []; this.scanWarnings = []; this.offline = false;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`整理记录无法读取。原照片未被更改。请保留 ${this.dataDir} 中的记录和备份后再恢复。`);
      this.state = { version: 1, active: null, libraries: {} };
    }
    if (this.state.version !== 1 || !this.state.libraries) throw new Error('整理记录版本不兼容，请保留记录文件。');
    return this;
  }
  get lib() { return this.state.libraries[this.state.active]; }
  async save() {
    const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(this.state)); await handle.sync(); } finally { await handle.close(); }
    try { await fs.copyFile(this.file, this.file + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fs.rename(tmp, this.file);
    // fsync the directory where supported, so rename survives a system crash.
    try { const dir = await fs.open(this.dataDir, 'r'); try { await dir.sync(); } finally { await dir.close(); } } catch {}
  }
  async choose(root) {
    if (this.lib?.draft || this.lib?.undoing) throw new Error('请先完成当前整理，或在首页放弃未确认的选择。');
    root = await fs.realpath(root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('请选择一个照片文件夹。');
    // Nested libraries could rediscover the same photos with different identities.
    for (const lib of Object.values(this.state.libraries)) {
      if (root !== lib.root && (root.startsWith(lib.root + path.sep) || lib.root.startsWith(root + path.sep))) throw new Error('这个文件夹与已有照片库重叠，请选择原照片库或另一个独立文件夹。');
    }
    const id = hash(root);
    this.state.libraries[id] ??= { id, root, records: {}, history: [], draft: null, undoing: null };
    this.state.active = id;
    await this.save(); await this.scan(); return this.snapshot();
  }
  async scan() {
    if (!this.lib) return;
    const root = this.lib.root; const photos = []; const warnings = [];
    this.onProgress({ phase: 'scan', count: 0 });
    try { if (!(await fs.stat(root)).isDirectory()) throw new Error(); } catch { this.offline = true; this.photos = []; return; }
    this.offline = false;
    const walk = async (directory, relative = '') => {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch { warnings.push(relative || path.basename(root)); return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink() || entry.name === MANAGED) continue;
        const rel = path.join(relative, entry.name); const full = path.join(root, rel);
        if (entry.isDirectory()) await walk(full, rel);
        else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const st = await fs.stat(full); const sig = signature(st); const id = hash(`${rel}\0${sig}`);
            photos.push({ id, relative: rel, name: entry.name, size: st.size, signature: sig, taken: null });
            if (photos.length % 100 === 0) this.onProgress({ phase: 'scan', count: photos.length });
          } catch { warnings.push(rel); }
        }
      }
    };
    await walk(root);
    // Bounded metadata reads; exifr reads needed segments, never decodes pixels.
    let cursor = 0;
    const oldDates = this.lib.dates || {};
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (cursor < photos.length) {
        const photo = photos[cursor++];
        if (Object.hasOwn(oldDates, photo.id)) photo.taken = oldDates[photo.id];
        else {
          try { const tags = await exifr.parse(path.join(root, photo.relative), { pick: ['DateTimeOriginal'], translateValues: true }); photo.taken = captureDate(tags?.DateTimeOriginal); } catch {}
        }
        if (cursor % 100 === 0) this.onProgress({ phase: 'dates', count: cursor, total: photos.length });
      }
    }));
    this.lib.dates = Object.fromEntries(photos.map(p => [p.id, p.taken]));
    photos.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN', { numeric: true }));
    this.photos = photos; this.scanWarnings = warnings;
    await this.save();
  }
  allHistory() { return Object.values(this.state.libraries).flatMap(l => l.history).filter(h => !h.undone); }
  stats() {
    const history = this.allHistory(); const today = dayKey(this.now());
    const dates = new Set(history.map(h => h.day)); let cursor = dates.has(today) ? today : previousDay(today); let streak = 0;
    while (dates.has(cursor)) { streak++; cursor = previousDay(cursor); }
    const choices = history.flatMap(h => h.choices);
    return { total: choices.length, deleted: choices.filter(c => c.status === 'delete').length,
      bytes: choices.filter(c => c.status === 'delete').reduce((sum, c) => sum + c.photo.size, 0), streak,
      today: history.filter(h => h.day === today).reduce((sum, h) => sum + h.choices.length, 0),
      last: history.length ? history.map(h => h.confirmedAt).sort().at(-1) : null };
  }
  eligible() {
    if (!this.lib) return [];
    const today = dayKey(this.now());
    return this.photos.filter(p => { const r = this.lib.records[p.id]; return !r || (r.status === 'later' && r.day < today); });
  }
  snapshot() {
    const stats = this.stats(); const lib = this.lib;
    const eligible = this.eligible(); const memories = eligible.filter(p => anniversary(p, this.now()));
    const years = {};
    for (const p of memories) years[p.taken.year] = (years[p.taken.year] || 0) + 1;
    const memoryYear = Object.keys(years).sort().at(-1);
    return { library: lib ? { name: path.basename(lib.root), root: lib.root } : null,
      total: this.photos.length, remaining: eligible.length, deferred: this.photos.filter(p => lib?.records[p.id]?.status === 'later').length,
      quota: Math.max(0, 20 - stats.today), stats, draft: lib?.draft || null,
      latest: lib?.history.filter(h => !h.undone).at(-1) || null,
      undoing: Boolean(lib?.undoing), warnings: this.scanWarnings.length, offline: this.offline,
      memory: memoryYear ? { years: this.now().getFullYear() - Number(memoryYear), count: years[memoryYear] } : null };
  }
  async start() {
    if (!this.lib) throw new Error('请先选择照片文件夹。');
    if (this.lib.undoing) throw new Error('请先完成恢复操作。');
    if (this.lib.draft) return this.snapshot();
    if (this.offline) throw new Error('找不到照片文件夹，请重新连接磁盘后刷新。');
    const quota = Math.max(0, 20 - this.stats().today);
    if (!quota) throw new Error('今天的 20 张已经够了，明天再来。');
    const photos = this.eligible().sort((a, b) => Number(anniversary(b, this.now())) - Number(anniversary(a, this.now()))).slice(0, quota);
    if (!photos.length) throw new Error('今天没有待整理的照片了。');
    this.lib.draft = { id: crypto.randomUUID(), day: dayKey(this.now()), photos, choices: [], transaction: null };
    await this.save(); return this.snapshot();
  }
  async decide(id, status) {
    const draft = this.lib?.draft;
    if (!draft || draft.transaction || !STATUSES.has(status) || draft.photos[draft.choices.length]?.id !== id) throw new Error('照片已切换，请重试当前选择。');
    draft.choices.push({ id, status }); await this.save(); return this.snapshot();
  }
  async undoStep() {
    const draft = this.lib?.draft;
    if (!draft || draft.transaction) throw new Error('已开始确认，请先完成确认或恢复原位。');
    draft.choices.pop(); await this.save(); return this.snapshot();
  }
  async revise(id, status) {
    const draft = this.lib?.draft;
    if (!draft || draft.transaction || !STATUSES.has(status)) throw new Error('当前结果不可修改。');
    const choice = draft.choices.find(c => c.id === id);
    if (!choice) throw new Error('找不到这次选择。');
    choice.status = status; await this.save(); return this.snapshot();
  }
  async discard() {
    if (this.lib?.draft?.transaction) throw new Error('部分照片可能已经移动，请先恢复原位。');
    if (this.lib) { this.lib.draft = null; await this.save(); }
    return this.snapshot();
  }
  async confirm() {
    const lib = this.lib; const draft = lib?.draft;
    if (!draft || draft.choices.length !== draft.photos.length) throw new Error('请先看完本次照片。');
    if (lib.undoing) throw new Error('请先恢复原位。');
    if (!draft.transaction) {
      // Validate every photo, including kept photos, before committing anything.
      const ops = [];
      for (const [i, choice] of draft.choices.entries()) {
        const photo = draft.photos[i];
        if (choice.status === 'later') continue; // Missing/unreadable photos can safely be deferred.
        const source = await safePath(lib.root, photo.relative);
        if (signature(await fs.stat(source)) !== photo.signature) throw new Error(`照片已被其他程序改动，请返回结果并重新选择文件夹：${photo.name}`);
        if (['favorite', 'delete'].includes(choice.status)) {
          ops.push({ id: photo.id, from: photo.relative,
            to: path.join(MANAGED, choice.status === 'favorite' ? '收藏' : '待删除', draft.id, `${String(i + 1).padStart(2, '0')}-${photo.name}`),
            expected: { size: photo.size, sha256: await digest(source) } });
        }
      }
      draft.transaction = { ops, day: dayKey(this.now()) };
      await this.save();
    }
    for (const [index, op] of draft.transaction.ops.entries()) {
      this.onProgress({ phase: 'move', count: index + 1, total: draft.transaction.ops.length });
      await safeMove(lib.root, op.from, op.to, op.expected);
    }
    const choices = draft.choices.map((c, i) => ({ ...c, photo: draft.photos[i], previous: lib.records[c.id] || null }));
    const batch = { id: draft.id, day: draft.transaction.day, confirmedAt: this.now().toISOString(), choices, ops: draft.transaction.ops, undone: false };
    for (const c of choices) lib.records[c.id] = { status: c.status, day: batch.day, batch: batch.id };
    lib.history.push(batch); lib.draft = null;
    await this.save(); await this.scan(); return this.snapshot();
  }
  async restore() {
    const lib = this.lib;
    if (!lib) throw new Error('请先选择照片文件夹。');
    if (!lib.undoing) {
      if (lib.draft?.transaction) lib.undoing = { kind: 'pending', ops: lib.draft.transaction.ops };
      else {
        if (lib.draft) throw new Error('请先完成或放弃未确认的选择。');
        const last = lib.history.filter(h => !h.undone).at(-1);
        if (!last) throw new Error('还没有可撤销的整理。');
        lib.undoing = { kind: 'confirmed', batch: last.id, ops: last.ops };
      }
      await this.save();
    }
    for (const op of [...lib.undoing.ops].reverse()) {
      // Not-yet-moved pending items are already at the original location.
      const dest = await safePath(lib.root, op.to, true);
      if (!await exists(dest)) { await verify(await safePath(lib.root, op.from), op.expected).then(ok => { if (!ok) throw new Error('原照片和整理后的照片均不可用，请重新连接磁盘。'); }); continue; }
      await safeMove(lib.root, op.to, op.from, op.expected);
    }
    if (lib.undoing.kind === 'confirmed') {
      const batch = lib.history.find(h => h.id === lib.undoing.batch);
      for (const c of batch.choices) { if (c.previous) lib.records[c.id] = c.previous; else delete lib.records[c.id]; }
      batch.undone = true;
      // Restored files can get a new mtime when a filesystem requires copy fallback.
      const photos = [];
      for (const c of batch.choices) {
        const st = await fs.stat(within(lib.root, c.photo.relative)).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        const photo = st ? { ...c.photo, signature: signature(st), size: st.size } : { ...c.photo };
        photo.id = hash(`${photo.relative}\0${photo.signature}`); photos.push(photo);
      }
      lib.draft = { id: crypto.randomUUID(), day: dayKey(this.now()), photos, choices: [], transaction: null };
    } else {
      lib.draft.transaction = null;
      for (const p of lib.draft.photos) {
        const st = await fs.stat(within(lib.root, p.relative)).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
        if (st) p.signature = signature(st);
      }
    }
    lib.undoing = null;
    await this.save(); await this.scan(); return this.snapshot();
  }
  photoById(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('无效照片。');
    const draft = this.lib?.draft;
    const p = draft?.photos.find(p => p.id === id) || this.photos.find(p => p.id === id);
    if (p) {
      const moved = draft?.transaction?.ops.find(op => op.id === id);
      return { photo: p, candidates: [p.relative, ...(moved ? [moved.to] : [])] };
    }
    for (const batch of [...(this.lib?.history || [])].reverse()) {
      const c = batch.choices.find(c => c.id === id);
      if (c) return { photo: c.photo, candidates: [batch.ops.find(op => op.id === id)?.to, c.photo.relative].filter(Boolean) };
    }
    throw new Error('找不到这张照片。');
  }
  async photoPath(id) {
    const { photo, candidates } = this.photoById(id);
    for (const rel of candidates) {
      try { const file = await safePath(this.lib.root, rel); if (await exists(file)) return { file, photo }; } catch {}
    }
    throw new Error('照片已移动或磁盘已断开。');
  }
}
module.exports = { Library, dayKey, previousDay, safeMove, safePath, digest, signature, hash, MANAGED };
