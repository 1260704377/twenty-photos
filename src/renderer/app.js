const $ = selector => document.querySelector(selector);
const icons = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>', back: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  later: '<path d="m5 5 10 7-10 7V5ZM19 5v14"/>', folder: '<path d="M3 7V5h6l2 2h10v13H3V7Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  undo: '<path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5m-5 5 5 5" transform="translate(0 -2)"/>',
  leaf: '<path d="M4 21C2 7 12 3 21 3c0 12-4 18-13 15M4 21 17 7M9 15v-5m0 5h5"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  refresh: '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = n => new Intl.NumberFormat('zh-CN').format(n || 0);
const bytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
const names = { delete: '待删除', keep: '保留', favorite: '收藏', later: '稍后决定' };
let state = null, view = 'home', busy = false, photoReady = false, photoFailed = false, noticeTimer, prefetch, modalReturnFocus;
function notice(message, temporary = false) {
  clearTimeout(noticeTimer);
  $('#notice').innerHTML = `${esc(message)}<button aria-label="关闭提示">${icon('close')}</button>`;
  $('#notice').hidden = false; $('#notice button').onclick = () => $('#notice').hidden = true;
  if (temporary) noticeTimer = setTimeout(() => $('#notice').hidden = true, 5000);
}
function busyMessage(text) { $('#busy-text').textContent = text; }
async function call(channel, args = [], message = '正在记下你的选择…') {
  if (busy) return false;
  busy = true; $('#busy').hidden = false; busyMessage(message);
  document.querySelectorAll('#app button, #dialog button, #dialog select').forEach(b => { b.dataset.wasDisabled = b.disabled ? '1' : '0'; b.disabled = true; });
  try {
    const result = await window.twenty.invoke(channel, ...args);
    if (!result.ok) {
      if (result.state) { state = result.state; render(); }
      notice(result.error); return false;
    }
    state = result.value; return true;
  } catch (e) { notice('暂时无法连接本地程序，请关闭后重新打开。已保存的选择会保留。'); return false; }
  finally {
    busy = false; $('#busy').hidden = true;
    document.querySelectorAll('[data-was-disabled]').forEach(b => { b.disabled = b.dataset.wasDisabled === '1'; delete b.dataset.wasDisabled; });
  }
}
window.twenty.onProgress(p => {
  if (p.phase === 'scan') busyMessage(`正在找到你的照片 · ${number(p.count)} 张`);
  if (p.phase === 'dates') busyMessage(`正在读拍摄日期 · ${number(p.count)} / ${number(p.total)}`);
  if (p.phase === 'move') busyMessage(`正在安全整理 · ${p.count} / ${p.total}`);
  if (p.phase === 'busy') notice('正在保存，请稍等片刻再关闭。', true);
});
const brand = `<button class="brand" data-action="home" aria-label="20张，回到首页"><span class="brand-mark">20</span><span>20张</span></button>`;
function header() {
  return `<header class="header">${brand}<span class="header-note">慢慢整理，好好留住。</span><div class="header-right">${state?.library ? `<button class="text-button folder-name" data-action="show-folder" title="${esc(state.library.root)}">${icon('folder')}${esc(state.library.name)}</button>` : `<span class="eyebrow">ONE DAY, TWENTY PHOTOS</span>`}</div></header>`;
}
function footer() {
  const s = state?.stats || {};
  return `<footer class="footer"><div class="stats-inline"><span>连续整理 <b>${number(s.streak)}</b> 天</span><span>已经整理 <b>${number(s.total)}</b> 张</span></div><span class="local-note">${icon('lock')} 照片和回忆，都只留在本机</span></footer>`;
}
function ritual() {
  return `<div class="ritual" aria-hidden="true"><div class="halo"></div><div class="daily-sheet"><div class="sheet-label">A LITTLE, EVERY DAY</div><div class="sheet-number">20</div><div class="sheet-bottom">一天一点 · 刚刚好</div></div><span class="small-leaf">${icon('leaf')}</span><p class="ritual-caption">把回忆，慢慢收好。</p></div>`;
}
function recovery() {
  return state.undoing || state.draft?.transaction ? `<div class="recovery">有一次文件整理还未完成。操作记录已保留。<br>连接好原磁盘后，可以重试，或 <button data-action="restore">将本次照片恢复原位</button>。</div>` : '';
}
function home() {
  if (!state?.library) return `<div class="shell">${header()}<main class="home empty"><div class="home-copy"><div class="eyebrow">给回忆一点时间</div><div class="empty-count">20.</div><h1>照片很多，<br><strong>从今天的 20 张开始。</strong></h1><p class="intro">不用一口气整理完。<br>选一个照片文件夹，今天只做一点点。</p><button class="primary" data-action="choose">选择照片文件夹 ${icon('folder')}</button><p class="quiet-line">支持 JPG、PNG、HEIC 等常见照片格式<br>无需账号，也无需上传。</p></div>${ritual()}</main>${footer()}</div>`;
  const draft = state.draft; const done = state.quota === 0; const empty = state.remaining === 0;
  let title = '但今天，<br><strong>只看 20 张。</strong>';
  let cta = '开始今天的整理'; let action = 'start';
  if (draft) { cta = draft.choices.length === draft.photos.length ? '查看这次的选择' : `继续今天的整理 · ${draft.choices.length} / ${draft.photos.length}`; action = 'resume'; }
  else if (state.offline) { title = '回忆还在，<br><strong>等磁盘回来。</strong>'; cta = '重新连接后刷新'; action = 'refresh'; }
  else if (done) { title = '今天已经够了，<br><strong>剩下的，明天再说。</strong>'; cta = '查看今天的结果'; action = 'today'; }
  else if (empty) { title = state.deferred ? '今天先到这里，<br><strong>明天再看也很好。</strong>' : '每一张回忆，<br><strong>都有了归处。</strong>'; cta = '看看有没有新照片'; action = 'refresh'; }
  else if (state.remaining < state.quota) title = `慢慢来，<br><strong>今天只看 ${state.remaining} 张。</strong>`;
  else if (state.quota < 20) title = `今天还剩，<br><strong>${state.quota} 次小选择。</strong>`;
  return `<div class="shell">${header()}<main class="home"><div class="home-copy"><div class="eyebrow">${done ? '今日份的小小成就' : '给回忆一点时间'}</div><div class="count">${state.offline ? '—' : number(done ? state.stats.today : state.remaining)}</div><p class="count-caption">${done ? '张照片，今天已经好好看过。' : empty && !state.offline ? state.deferred ? '张照片今天需要决定。其余的，之后再说。' : '张照片等着你。都整理好了。' : '张照片等着你。'}</p><h1>${title}</h1>${recovery()}<button class="primary" data-action="${action}" ${state.undoing || (done && !state.latest) ? 'disabled' : ''}>${cta} ${icon(done ? 'check' : 'arrow')}</button><p class="quiet-line">${draft ? '上次的选择已经保存，随时可以接着来。' : done ? '一天一点点，就是很好的进展。' : empty ? state.deferred ? `${state.deferred} 张「稍后决定」的照片，会在之后回来。` : '新的照片，也可以慢慢加入。' : `文件夹中找到 ${number(state.total)} 张照片。别急，慢慢来。`}</p>${state.warnings ? `<p class="warning-inline">有 ${state.warnings} 个文件或子文件夹无法读取，请检查权限后刷新。</p>` : ''}<div class="finish-after"><button class="text-button" data-action="choose" ${draft || state.undoing ? 'disabled' : ''}>更换文件夹</button><button class="text-button" data-action="refresh">${icon('refresh')}刷新</button>${draft && !draft.transaction ? '<button class="text-button" data-action="discard">放弃本次选择</button>' : ''}${!draft && state.latest ? '<button class="text-button" data-action="latest">最近一次整理</button>' : ''}</div></div>${ritual()}</main>${state.memory && !done ? `<aside class="memory-note">${icon('sun')}<span><strong>${state.memory.years} 年前的今天，你拍了 ${state.memory.count} 张照片。</strong> 今天，优先重新看看它们。</span></aside>` : ''}${footer()}</div>`;
}
function review() {
  const d = state.draft; if (!d || d.choices.length === d.photos.length) { view = 'complete'; return complete(); }
  const i = d.choices.length; const p = d.photos[i];
  return `<div class="shell review-shell"><header class="review-header"><button class="text-button" data-action="home">${icon('back')} 暂时离开</button><div class="review-progress"><b>${i + 1}</b> / ${d.photos.length}</div><span class="eyebrow">只专注于这一张</span></header><progress class="progress-track" max="${d.photos.length}" value="${i}" aria-label="已处理照片数"></progress><main class="photo-area" id="photo-area"><div class="photo-loading"><span class="spinner"></span>正在打开这一刻…</div><img id="current-photo" src="twenty://photo/${p.id}" alt="${esc(p.name)}"></main><div class="photo-meta"><span class="photo-name">${esc(p.name)}</span><span>${p.taken ? `${p.taken.year} 年 ${p.taken.month} 月 ${p.taken.day} 日` : '不必记得日期，也可以留住这一刻'}</span></div><div class="actions"><button class="decision delete" data-decision="delete" disabled>${icon('close')}不要了<kbd>←</kbd></button><button class="decision keep" data-decision="keep" disabled>${icon('arrow')}保留<kbd>→</kbd></button><button class="decision favorite" data-decision="favorite" disabled>${icon('heart')}收藏<kbd>↑</kbd></button><button class="decision later" data-decision="later">${icon('later')}稍后决定<kbd>空格</kbd></button></div><div class="review-bottom"><button class="text-button" data-action="undo" ${i === 0 ? 'disabled' : ''}>${icon('undo')} 撤销上一步 <span class="undo-hint">⌘ / Ctrl Z</span></button><span>最终确认前，原照片不会改变</span></div></div>`;
}
function complete() {
  const draft = state.draft; const batch = draft ? { choices: draft.choices.map((c, i) => ({ ...c, photo: draft.photos[i] })) } : state.latest;
  if (!batch) { view = 'home'; return home(); }
  const counts = Object.fromEntries(Object.keys(names).map(k => [k, batch.choices.filter(c => c.status === k).length]));
  const count = batch.choices.length; const pendingBytes = batch.choices.filter(c => c.status === 'delete').reduce((s, c) => s + c.photo.size, 0);
  return `<div class="shell">${header()}<main class="finished"><div class="check-seal">${icon('check')}</div><div class="eyebrow">${draft ? '今天的一小步，已经走完' : '好好留住，也轻轻放下'}</div><h1>${draft ? `今天的 ${count} 张，已经看完了。` : '今天整理完成。'}</h1><p class="subtitle">${draft ? '再确认一下，就可以安心收工。' : '不用再多做一点。剩下的，明天再说。'}</p><div class="result-counts">${Object.keys(names).map(k => `<div class="result-count ${k}"><b>${counts[k]}</b><span>${k === 'delete' && draft ? '准备删除' : names[k]}</span></div>`).join('')}</div><div class="completion-stats"><span>连续 <strong>${state.stats.streak}</strong> 天</span><span>累计整理 <strong>${number(state.stats.total)}</strong> 张</span><span>累计待清理 <strong>${bytes(state.stats.bytes)}</strong></span></div>${recovery()}<p class="safety-copy">${draft ? `确认后，${counts.delete} 张移入「20张整理 / 待删除」，${counts.favorite} 张移入「收藏」。<br>保留和稍后决定的照片留在原处。没有照片会被永久删除。` : `本次待清理 ${bytes(pendingBytes)}，照片仍在「待删除」中，可随时找回。<br>待清理空间尚未释放。稍后决定的照片，之后会再次出现。`}</p><div class="finish-actions">${draft ? `<button class="primary" data-action="confirm" ${state.undoing ? 'disabled' : ''}>${draft.transaction ? '重试完成本次整理' : '确认本次整理'} ${icon('check')}</button>` : `<button class="primary" data-action="home">今天就到这里 ${icon('check')}</button>`}<button class="secondary" data-action="results">${draft ? '查看今天的结果' : '查看本次结果'}</button></div><div class="finish-after">${draft && !draft.transaction ? '<button class="text-button" data-action="undo">撤销最后一张</button>' : ''}${!draft ? `<button class="text-button" data-action="show-folder">${icon('folder')}打开照片文件夹</button><button class="text-button" data-action="restore">${icon('undo')}撤销本次整理</button>` : ''}</div>${draft ? '<p class="fine-print">未确认的选择已自动保存，关闭后仍可继续。</p>' : ''}</main>${footer()}</div>`;
}
function render() {
  photoReady = false; photoFailed = false;
  $('#app').innerHTML = view === 'review' ? review() : view === 'complete' ? complete() : home();
  const img = $('#current-photo');
  if (img) {
    const loaded = () => {
      if ($('#current-photo') !== img) return;
      photoReady = true; $('#photo-area').classList.add('loaded');
      document.querySelectorAll('[data-decision]').forEach(b => { b.disabled = busy; b.dataset.wasDisabled = '0'; });
      const next = state.draft?.photos[state.draft.choices.length + 1];
      if (next) { prefetch = new Image(); prefetch.src = `twenty://photo/${next.id}`; }
    };
    img.onload = loaded;
    img.onerror = () => {
      if ($('#current-photo') !== img) return;
      photoFailed = true;
      $('#photo-area').innerHTML = `<div class="photo-error">${icon('photo')}<strong>这张照片暂时打不开。</strong><span>文件可能已移动，或格式暂不支持。<br>选「稍后决定」就好，原照片不会改变。</span><button class="secondary" data-action="retry-photo">重新加载</button></div>`;
    };
    if (img.complete && img.naturalWidth) loaded();
  }
}
async function decision(status) {
  if (busy || view !== 'review' || $('#dialog').open || (!photoReady && status !== 'later')) return;
  const p = state.draft?.photos[state.draft.choices.length]; if (!p) return;
  if (await call('decide', [p.id, status])) { if (state.draft.choices.length === state.draft.photos.length) view = 'complete'; render(); }
}
function openDialog(html, narrow = false) {
  modalReturnFocus = document.activeElement;
  $('#dialog').className = narrow ? 'confirm-dialog' : '';
  $('#dialog').innerHTML = html; $('#dialog').showModal();
}
function closeDialog() { $('#dialog').close(); modalReturnFocus?.focus(); }
function ask(title, description, label, onConfirm) {
  openDialog(`<div class="dialog-head"><h2>${title}</h2><button data-close aria-label="关闭">${icon('close')}</button></div><p>${description}</p><div class="dialog-actions"><button class="secondary" data-close>取消</button><button class="primary" id="dialog-confirm">${label}</button></div>`, true);
  $('#dialog-confirm').onclick = async () => { closeDialog(); await onConfirm(); };
}
function results() {
  const d = state.draft; const choices = d ? d.choices.map((c, i) => ({ ...c, photo: d.photos[i] })) : state.latest?.choices || [];
  const editable = d && !d.transaction;
  openDialog(`<div class="dialog-head"><h2>${editable ? '再看一眼你的选择' : '这次整理的回忆'}</h2><button data-close aria-label="关闭结果">${icon('close')}</button></div><p class="dialog-description">${editable ? '可以在这里改主意。最终确认前，原照片不会改变。' : '照片仍在你的本地文件夹中；撤销本次整理可以恢复原位。'}</p><div class="result-grid">${choices.map(c => `<div class="result-item"><img loading="lazy" src="twenty://photo/${c.id}" alt="${esc(c.photo.name)}"><p class="result-filename" title="${esc(c.photo.relative)}">${esc(c.photo.name)}</p>${editable ? `<select data-revise="${c.id}" aria-label="${esc(c.photo.name)} 的选择">${Object.entries(names).map(([k, v]) => `<option value="${k}" ${c.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : `<span class="tag">${names[c.status]}</span>`}</div>`).join('')}</div><div class="dialog-actions"><button class="primary" data-close>看好了 ${icon('check')}</button></div>`);
}
const actions = {
  home: async () => { view = 'home'; render(); },
  choose: async () => { if (await call('choose', [], '请选择照片文件夹…')) { view = 'home'; render(); } },
  refresh: async () => { if (await call('load', [], '正在检查照片文件夹…')) render(); },
  start: async () => { if (await call('start')) { view = 'review'; render(); } },
  resume: async () => { view = state.draft.choices.length === state.draft.photos.length ? 'complete' : 'review'; render(); },
  undo: async () => { if (await call('undo')) { view = 'review'; render(); } },
  confirm: async () => { if (await call('confirm', [], '正在安全保存本次整理，请稍候…')) { view = 'complete'; render(); notice('整理已确认。照片都还在，可以安心收工。', true); } },
  results: async () => results(),
  latest: async () => { view = 'complete'; render(); },
  today: async () => { view = 'complete'; render(); },
  'show-folder': async () => { await call('show-folder'); },
  'retry-photo': async () => render(),
  restore: async () => ask('把这次选择放回原点？', '收藏和待删除的照片会恢复到原位置，已有文件不会被覆盖。这次的统计会撤回，你可以重新做选择。', '恢复原位', async () => { if (await call('restore', [], '正在将照片安全恢复原位…')) { view = 'home'; render(); notice('照片已恢复原位，可以重新选择。', true); } }),
  discard: async () => ask('暂时放下这次选择？', '尚未确认的选择会被清空，原照片保持原样。以后仍然可以重新开始。', '放弃本次选择', async () => { if (await call('discard')) { view = 'home'; render(); } })
};
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button || button.disabled || busy) return;
  if (button.hasAttribute('data-close')) return closeDialog();
  if (button.dataset.decision) return decision(button.dataset.decision);
  await actions[button.dataset.action]?.();
});
document.addEventListener('change', async e => {
  if (!e.target.matches('[data-revise]')) return;
  const select = e.target; const old = state.draft.choices.find(c => c.id === select.dataset.revise).status;
  if (await call('revise', [select.dataset.revise, select.value])) { render(); }
  else select.value = old;
});
document.addEventListener('keydown', async e => {
  if (busy || $('#dialog').open || e.repeat || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && state?.draft && !state.draft.transaction && state.draft.choices.length && ['review', 'complete'].includes(view)) { e.preventDefault(); await actions.undo(); return; }
  if (view !== 'review' || e.metaKey || e.ctrlKey || e.altKey) return;
  const keys = { ArrowLeft: 'delete', ArrowRight: 'keep', ArrowUp: 'favorite', ' ': 'later' };
  if (keys[e.key]) { e.preventDefault(); await decision(keys[e.key]); }
  if (e.key === 'Escape') { e.preventDefault(); await actions.home(); }
});
$('#dialog').addEventListener('cancel', e => { if (busy) e.preventDefault(); });
async function init() {
  if (!window.twenty) { $('#app').innerHTML = '<main class="shell"><h1>请通过「20张」桌面应用打开。</h1><p>这个界面需要本地照片访问能力。</p></main>'; return; }
  render();
  if (await call('load', [], '正在打开你的照片记录…')) { view = state.draft?.choices.length === state.draft?.photos.length && state.draft ? 'complete' : 'home'; render(); }
}
init();

// A window left open overnight should welcome a new day without requiring a restart.
let calendarDay = new Date().toLocaleDateString();
async function refreshDay() {
  const today = new Date().toLocaleDateString();
  if (today !== calendarDay && !busy && !document.querySelector('#dialog').open) {
    if (await call('state')) { calendarDay = today; render(); }
  }
}
window.addEventListener('focus', refreshDay);
setInterval(refreshDay, 60000);
document.addEventListener('error', event => {
  const target = event.target;
  if (target instanceof HTMLImageElement && target.closest('.result-item')) {
    const placeholder = document.createElement('div');
    placeholder.className = 'thumbnail-unavailable';
    placeholder.innerHTML = `${icon('photo')}<span>暂时无法预览</span>`;
    target.replaceWith(placeholder);
  }
}, true);
