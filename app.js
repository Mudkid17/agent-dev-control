function statusCls(s){ return s==='运行中' ? 'running' : s==='异常' ? 'starting' : 'starting'; }

const state = {
  statusHistory: { all: [], rapid: [], frontend: [], backend: [], qa: [] },
  replyHistory: { all: [], rapid: [], frontend: [], backend: [], qa: [] }
};

const AGENT_KEY_BY_NAME = {
  '你（总控）': 'rapid',
  '前端智能体': 'frontend',
  '后端智能体': 'backend',
  'QA智能体': 'qa'
};

const KEY_LABEL = { rapid: '总控', frontend: '前端', backend: '后端', qa: 'qa', all: '全部' };

function currentTarget(){ return document.getElementById('target').value; }
function now(){ return new Date().toLocaleTimeString('zh-CN'); }

function pushStatus(agentKey, text){
  const norm = String(text || '').replace(/\s+/g,' ').trim();
  const rec = { ts: Date.now(), text: norm };
  const list = state.statusHistory[agentKey] || [];

  // 只在内容变化时记录（不按时间重复刷）
  const existsSame = list.some(x => x.text === norm);
  if (!existsSame) list.push(rec);
  state.statusHistory[agentKey] = list.slice(-40);

  const all = state.statusHistory.all || [];
  const allText = `[${KEY_LABEL[agentKey] || agentKey}] ${norm}`;
  const allExists = all.some(x => x.text === allText);
  if (!allExists) all.push({ ts: rec.ts, text: allText });
  state.statusHistory.all = all.slice(-80);
}

function pushReply(agentKey, who, text){
  const rec = { ts: Date.now(), text: `${who}: ${text}` };
  const arr = state.replyHistory[agentKey] || [];
  arr.push(rec);
  state.replyHistory[agentKey] = arr.slice(-30);

  const all = state.replyHistory.all;
  all.push({ ts: rec.ts, text: `[${agentKey}] ${rec.text}` });
  state.replyHistory.all = all.slice(-60);
}

function renderControl(c){
  const lead = document.getElementById('leadCard');
  const q5 = c.quota5hLeftPct;
  const qd = c.quotaDayLeftPct;
  const left5h = Number.isFinite(q5) ? q5 : null;
  const leftDay = Number.isFinite(qd) ? qd : null;
  lead.innerHTML = `
    <div class="agent-head"><span class="icon role-control" title="总控调度">${c.icon}</span><div><div class="agent-tag">${c.tag}</div><h3>${c.name}</h3></div></div>
    <p class="role">${c.role}</p>
    <div class="status ${statusCls(c.status)}">● ${c.status}</div>
    <div class="line">${c.line1}</div>
    <div class="line dim">${c.line2}</div>

    <div class="token-panel">
      <div class="token-row"><span>5小时额度剩余</span><span>${left5h == null ? "--" : left5h + "%"}</span></div>
      <div class="token-bar"><span class="token-fill remain" style="width:${left5h == null ? "--" : left5h + "%"}"></span></div>
      <div class="token-row"><span>每日额度剩余</span><span>${leftDay == null ? "--" : leftDay + "%"}</span></div>
      <div class="token-bar"><span class="token-fill remain" style="width:${leftDay == null ? "--" : leftDay + "%"}"></span></div>
    </div>

    <div class="meta">${c.runtime}</div>`;
}

function renderExec(list){
  const el = document.getElementById('execGrid');
  el.innerHTML = list.map(a => `
    <article class="agent-card ${a.key}">
      <div class="agent-head"><span class="icon role-${a.key}">${a.icon}</span><div><div class="agent-tag">${a.tag}</div><h3>${a.name}</h3></div></div>
      <p class="role">${a.role}</p>
      <div class="status ${statusCls(a.status)}">● ${a.status}</div>
      <div class="line">${a.line1}</div>
      <div class="line dim">${a.line2}</div>
      <div class="meta">${a.runtime}</div>
    </article>`).join('');
}

function renderActivity(items){
  const ul = document.getElementById('activityList');
  ul.innerHTML = items.map(i => `<li><strong>${i.name}</strong> • <span style="color:#4de28a">${i.status}</span><br>${i.text}<br><span class="time">${i.time}</span></li>`).join('');
}

function renderSummary(s){
  const chips = document.querySelectorAll('.chips .chip');
  if (chips.length < 5) return;
  chips[0].textContent = `${s.blocked} 个阻塞`;
  chips[1].textContent = `${s.unassigned} 条待分配`;
  chips[2].textContent = `${s.review} 条待验收`;
  chips[3].textContent = `${s.idle} 个空闲`;
  chips[4].textContent = `${s.errors} 个异常`;
}

function renderConsole(){
  const t = currentTarget();
  const logEl = document.getElementById('consoleLog');
  const countEl = document.getElementById('msgCount');
  const statuses = (state.statusHistory[t] || []).slice(-20);
  const replies = (state.replyHistory[t] || []).slice(-10);

  const lines = [];
  lines.push('【状态历史】');
  if (!statuses.length) {
    lines.push('暂无状态记录');
  } else {
    for (const s of statuses) lines.push(`[${new Date(s.ts).toLocaleTimeString('zh-CN')}] ${s.text}`);
  }

  // 全部智能体视图：不显示消息回复区
  if (t !== 'all') {
    lines.push('');
    lines.push('【消息回复】');
    if (!replies.length) {
      lines.push('暂无回复记录');
    } else {
      for (const r of replies) lines.push(`[${new Date(r.ts).toLocaleTimeString('zh-CN')}] ${r.text}`);
    }
  }

  const total = t === 'all' ? statuses.length : (statuses.length + replies.length);
  countEl.textContent = `${total} 条记录`;
  logEl.textContent = lines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

async function sendMessage(){
  const target = currentTarget();
  const input = document.getElementById('msgInput');
  const txt = input.value.trim();
  if(!txt) return;
  if (target === 'all') return alert('请先选择单个智能体后再对话。');

  pushReply(target, '你', txt);
  renderConsole();
  input.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: target, text: txt })
    });
    const out = await res.json();
    if (!res.ok || !out.ok) {
      pushReply(target, '系统', `发送失败：${out.error || '未知错误'}`);
    } else {
      pushReply(target, '智能体', out.replyText || '已收到并执行');
      input.value = '';
    }
  } catch {
    pushReply(target, '系统', '发送失败：网络异常');
  } finally {
    input.disabled = false;
    input.focus();
    renderConsole();
  }
}

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('msgInput').addEventListener('keydown', (e)=>{ if(e.key === 'Enter') sendMessage(); });
document.getElementById('target').addEventListener('change', renderConsole);

async function refresh(){
  try {
    const r = await fetch('/api/dashboard');
    const d = await r.json();

    renderControl(d.control);
    renderExec(d.exec);
    renderActivity(d.activity.slice(0,6));
    renderSummary(d.summary);

    pushStatus('rapid', `${d.control.status}｜${d.control.line1}`);
    for (const a of d.exec) {
      const key = a.key === 'frontend' ? 'frontend' : a.key === 'backend' ? 'backend' : 'qa';
      pushStatus(key, `${a.status}｜${a.line1}`);
    }

    renderConsole();
  } catch(e) {
    console.error(e);
  }
}

refresh();
setInterval(refresh, 3000);
initLayoutEditor();


// ===== 布局编辑模式（可拖动窗口） =====
function initLayoutEditor(){
  const selector = '.layer.control, .layer.exec, .sidebar .side-card, .lead';
  const targets = [...document.querySelectorAll(selector)];

  targets.forEach((el, idx) => {
    if (!el.dataset.dragKey) el.dataset.dragKey = `panel_${idx}`;

    // 还原位置
    const savedPos = localStorage.getItem(`adc_pos_${el.dataset.dragKey}`);
    if (savedPos) {
      try {
        const {x,y} = JSON.parse(savedPos);
        el.style.transform = `translate(${x}px, ${y}px)`;
      } catch {}
    }

    // 还原尺寸
    const savedSize = localStorage.getItem(`adc_size_${el.dataset.dragKey}`);
    if (savedSize) {
      try {
        const {w,h} = JSON.parse(savedSize);
        if (Number.isFinite(w)) el.style.setProperty('width', `${w}px`, 'important');
        if (Number.isFinite(h)) el.style.setProperty('height', `${h}px`, 'important');
        el.style.setProperty('max-width', 'none', 'important');
        el.style.setProperty('min-width', '220px', 'important');
        el.style.setProperty('min-height', '120px', 'important');
      } catch {}
    }

    // 添加缩放手柄
    if (!el.querySelector(':scope > .resize-handle')) {
      const h = document.createElement('span');
      h.className = 'resize-handle';
      h.title = '拖拽调整大小';
      el.appendChild(h);
    }
  });

  let editOn = localStorage.getItem('adc_layout_edit') === '1';
  const btn = document.createElement('button');
  btn.className = 'layout-edit-btn';
  const setBtn = () => { btn.textContent = editOn ? '完成布局' : '布局编辑'; };
  setBtn();
  btn.onclick = () => {
    editOn = !editOn;
    localStorage.setItem('adc_layout_edit', editOn ? '1' : '0');
    document.body.classList.toggle('drag-edit-on', editOn);
    setBtn();
  };
  document.body.appendChild(btn);
  if (editOn) document.body.classList.add('drag-edit-on');

  let mode = null; // 'drag' | 'resize'
  let op = null;

  document.addEventListener('mousedown', (e) => {
    if (!editOn) return;

    const handle = e.target.closest('.resize-handle');
    if (handle) {
      const el = handle.parentElement;
      op = {
        el,
        sx: e.clientX,
        sy: e.clientY,
        ow: el.getBoundingClientRect().width,
        oh: el.getBoundingClientRect().height
      };
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('min-width', '220px', 'important');
      el.style.setProperty('min-height', '120px', 'important');
      mode = 'resize';
      e.preventDefault();
      return;
    }

    const el = e.target.closest(selector);
    if (!el) return;
    const m = (el.style.transform || '').match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    op = {
      el,
      sx: e.clientX,
      sy: e.clientY,
      ox: m ? parseFloat(m[1]) : 0,
      oy: m ? parseFloat(m[2]) : 0
    };
    mode = 'drag';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!op || !mode) return;

    if (mode === 'drag') {
      const x = op.ox + (e.clientX - op.sx);
      const y = op.oy + (e.clientY - op.sy);
      op.el.style.transform = `translate(${x}px, ${y}px)`;
      return;
    }

    if (mode === 'resize') {
      const w = Math.max(220, op.ow + (e.clientX - op.sx));
      const h = Math.max(120, op.oh + (e.clientY - op.sy));
      op.el.style.setProperty('width', `${w}px`, 'important');
      op.el.style.setProperty('height', `${h}px`, 'important');
    }
  });

  document.addEventListener('mouseup', () => {
    if (!op || !mode) return;

    if (mode === 'drag') {
      const m = (op.el.style.transform || '').match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
      const x = m ? parseFloat(m[1]) : 0;
      const y = m ? parseFloat(m[2]) : 0;
      localStorage.setItem(`adc_pos_${op.el.dataset.dragKey}`, JSON.stringify({x,y}));
    }

    if (mode === 'resize') {
      const rect = op.el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      localStorage.setItem(`adc_size_${op.el.dataset.dragKey}`, JSON.stringify({w,h}));
    }

    op = null;
    mode = null;
  });
}
