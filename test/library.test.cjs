const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Library, hash, digest, safeMove, MANAGED } = require('../src/main/library.cjs');
async function fixture(t, count = 25) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'twenty-unit-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'photos'); const data = path.join(base, 'data'); await fs.mkdir(root);
  for (let i = 0; i < count; i++) await fs.writeFile(path.join(root, `photo-${String(i).padStart(2, '0')}.jpg`), `test-photo-unique-content-${i}`);
  let today = new Date('2026-09-15T12:00:00'); const now = () => today;
  const lib = await new Library(data, { now }).init(); await lib.choose(root);
  return { root, data, lib, now, advance: date => today = new Date(`${date}T12:00:00`) };
}
async function finish(lib, statuses = ['delete', 'keep', 'favorite', 'later']) {
  await lib.start(); for (const [i, p] of lib.lib.draft.photos.entries()) await lib.decide(p.id, statuses[i % statuses.length]);
}
test('草稿、上一步撤销、结果修改持久化，确认前原照片字节不变', async t => {
  const { lib, root, data, now } = await fixture(t);
  const originals = await Promise.all((await fs.readdir(root)).map(async f => [f, await digest(path.join(root, f))]));
  await lib.start(); const first = lib.lib.draft.photos[0];
  await lib.decide(first.id, 'delete'); await lib.undoStep(); assert.equal(lib.lib.draft.choices.length, 0);
  await lib.decide(first.id, 'favorite'); await lib.revise(first.id, 'later');
  const reopened = await new Library(data, { now }).init(); await reopened.scan();
  assert.equal(reopened.lib.draft.choices[0].status, 'later');
  for (const [f, h] of originals) assert.equal(await digest(path.join(root, f)), h);
  assert.equal((await fs.readdir(root)).length, 25);
});
test('20 张完整确认、安全移动、总数统计、日限额、次日稍后再见', async t => {
  const { lib, root, advance } = await fixture(t);
  await finish(lib); const choices = structuredClone(lib.lib.draft.photos); await lib.confirm();
  assert.equal(lib.stats().total, 20); assert.equal(lib.stats().deleted, 5); assert.equal(lib.stats().streak, 1);
  assert.equal(lib.snapshot().quota, 0); await assert.rejects(lib.start(), /20 张/);
  for (const [i, p] of choices.entries()) {
    const original = await fs.access(path.join(root, p.relative)).then(() => true, () => false);
    assert.equal(original, i % 4 === 1 || i % 4 === 3);
  }
  assert.equal(lib.snapshot().remaining, 5);
  advance('2026-09-16'); assert.equal(lib.snapshot().remaining, 10);
  await lib.start(); assert.equal(lib.lib.draft.photos.length, 10);
  assert.ok(lib.lib.draft.photos.every(p => !lib.lib.records[p.id] || lib.lib.records[p.id].status === 'later'));
});
test('不足 20 张与全部整理完，重复确认不能重复计数', async t => {
  const { lib } = await fixture(t, 3); await finish(lib, ['keep']); await lib.confirm();
  assert.equal(lib.stats().total, 3); assert.equal(lib.snapshot().remaining, 0);
  await assert.rejects(lib.confirm()); await assert.rejects(lib.start(), /没有待整理/);
});
test('已确认的整理可恢复原位，统计撤回，允许重新选择', async t => {
  const { lib, root } = await fixture(t, 8); await finish(lib); await lib.confirm();
  await lib.restore();
  for (let i = 0; i < 8; i++) assert.equal(await fs.readFile(path.join(root, `photo-${String(i).padStart(2, '0')}.jpg`), 'utf8'), `test-photo-unique-content-${i}`);
  assert.equal(lib.stats().total, 0); assert.equal(lib.stats().bytes, 0); assert.equal(lib.lib.draft.choices.length, 0);
});
test('恢复时原位置出现新文件，不覆盖、不丢失，修复冲突后可继续', async t => {
  const { lib, root } = await fixture(t, 1); await finish(lib, ['delete']); await lib.confirm();
  const source = path.join(root, 'photo-00.jpg'); await fs.writeFile(source, 'new unrelated content');
  await assert.rejects(lib.restore(), /文件内容已变化/);
  assert.equal(await fs.readFile(source, 'utf8'), 'new unrelated content');
  assert.equal(lib.stats().total, 1); assert.ok(lib.lib.undoing);
  await fs.rename(source, path.join(root, 'unrelated.txt')); await lib.restore();
  assert.equal(await fs.readFile(source, 'utf8'), 'test-photo-unique-content-0'); assert.equal(lib.stats().total, 0);
});
test('确认前有照片变化，整批不移动', async t => {
  const { lib, root } = await fixture(t, 3); await finish(lib, ['delete']);
  await fs.writeFile(path.join(root, lib.lib.draft.photos[2].relative), 'changed');
  await assert.rejects(lib.confirm(), /照片已被其他程序改动/);
  assert.equal(lib.lib.draft.transaction, null);
  assert.equal((await fs.readdir(root)).length, 3);
});
test('崩溃发生在部分移动之后：重启从日志续做，不重复统计', async t => {
  const { lib, root, data, now } = await fixture(t, 3); await finish(lib, ['delete']);
  const ops = await Promise.all(lib.lib.draft.photos.map(async p => ({ id: p.id, from: p.relative, to: path.join(MANAGED, '待删除', lib.lib.draft.id, p.name), expected: { size: p.size, sha256: await digest(path.join(root, p.relative)) } })));
  lib.lib.draft.transaction = { ops, day: '2026-09-15' }; await lib.save();
  await safeMove(root, ops[0].from, ops[0].to, ops[0].expected);
  const reopened = await new Library(data, { now }).init(); await reopened.scan(); await reopened.confirm();
  assert.equal(reopened.stats().total, 3); assert.equal(reopened.lib.history.length, 1);
  for (const op of ops) assert.equal(await digest(path.join(root, op.to)), op.expected.sha256);
});
test('部分移动后也能安全恢复，而不是被迫提交', async t => {
  const { lib, root } = await fixture(t, 2); await finish(lib, ['favorite']);
  const ops = await Promise.all(lib.lib.draft.photos.map(async p => ({ id: p.id, from: p.relative, to: path.join(MANAGED, '收藏', lib.lib.draft.id, p.name), expected: { size: p.size, sha256: await digest(path.join(root, p.relative)) } })));
  lib.lib.draft.transaction = { ops, day: '2026-09-15' }; await lib.save(); await safeMove(root, ops[0].from, ops[0].to, ops[0].expected);
  await lib.restore(); assert.equal(lib.lib.draft.transaction, null); assert.equal(lib.stats().total, 0);
  for (const op of ops) assert.equal(await digest(path.join(root, op.from)), op.expected.sha256);
});
test('排除符号链接、隐藏目录、整理目录和非照片；子目录正常读取', async t => {
  const { lib, root } = await fixture(t, 1);
  await fs.mkdir(path.join(root, 'sub')); await fs.writeFile(path.join(root, 'sub', 'nested.png'), 'png');
  await fs.mkdir(path.join(root, MANAGED)); await fs.writeFile(path.join(root, MANAGED, 'skip.jpg'), 'skip');
  await fs.writeFile(path.join(root, 'video.mp4'), 'video'); await fs.symlink(path.join(root, 'photo-00.jpg'), path.join(root, 'shortcut.jpg'));
  await lib.scan(); assert.equal(lib.photos.length, 2);
});
test('恶意替换整理目录为符号链接时停止', async t => {
  const { lib, root, data } = await fixture(t, 1); await finish(lib, ['delete']);
  await fs.symlink(data, path.join(root, MANAGED)); await assert.rejects(lib.confirm(), /符号链接/);
  assert.equal(await fs.readFile(path.join(root, 'photo-00.jpg'), 'utf8'), 'test-photo-unique-content-0');
});
test('连续天数按本地日历，断一天归零；每日额度跨文件夹共享', async t => {
  const { lib, root, advance } = await fixture(t, 21);
  await finish(lib, ['keep']); await lib.confirm();
  const second = path.join(path.dirname(root), 'second'); await fs.mkdir(second); await fs.writeFile(path.join(second, 'p.jpg'), 'image');
  await lib.choose(second); assert.equal(lib.snapshot().quota, 0); await assert.rejects(lib.start());
  advance('2026-09-16'); await finish(lib, ['keep']); await lib.confirm(); assert.equal(lib.stats().streak, 2);
  advance('2026-09-18'); assert.equal(lib.stats().streak, 0);
});
test('空库、磁盘离线及损坏记录有明确状态', async t => {
  const { lib, root, data } = await fixture(t, 0); assert.equal(lib.snapshot().remaining, 0);
  await fs.rename(root, root + '-offline'); await lib.scan(); assert.equal(lib.snapshot().offline, true);
  await fs.writeFile(path.join(data, 'records.json'), '{invalid'); await assert.rejects(new Library(data).init(), /记录无法读取/);
});
test('过去的今天优先；未知拍摄日期不会伪造为文件修改日期', async t => {
  const { lib } = await fixture(t, 25); lib.photos[24].taken = { year: 2023, month: 9, day: 15 };
  assert.equal(lib.snapshot().memory.years, 3); await lib.start(); assert.equal(lib.lib.draft.photos[0].id, lib.photos[24].id);
  assert.equal(lib.photos[0].taken, null);
});
test('路径输入不可越界；重叠照片库被拒绝', async t => {
  const { lib, root } = await fixture(t, 1);
  await assert.rejects(lib.photoPath('../../secret'));
  await fs.mkdir(path.join(root, 'child')); await assert.rejects(lib.choose(path.join(root, 'child')), /重叠/);
});
test('照片被外部移走时仍能稍后决定，确认与撤销不会被无操作项阻塞', async t => {
  const { lib, root } = await fixture(t, 2); await finish(lib, ['keep', 'later']);
  await fs.rename(path.join(root, 'photo-01.jpg'), path.join(root, 'away.txt'));
  await lib.confirm(); assert.equal(lib.stats().total, 2);
  await lib.restore(); assert.equal(lib.stats().total, 0); assert.equal(lib.lib.draft.photos.length, 2);
});
