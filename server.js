const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync, spawn } = require('child_process');

const ROOT = __dirname;
const PORT = 8088;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const AGENT_IDS = {
  rapid: 'rapid-prototyper',
  frontend: 'frontend-developer',
  backend: 'backend-architect',
  qa: 'reality-checker'
};

const AGENT_META = {
  'rapid-prototyper': { name: '你（总控）', tag: '总控', icon: '🧠', role: '调度与决策', key: 'control', work: '拆解任务、调度前后端与QA' },
  'frontend-developer': { name: '前端智能体', tag: '前端', icon: '</>', role: '界面与交互', key: 'frontend', work: '实现页面、交互与样式细节' },
  'backend-architect': { name: '后端智能体', tag: '后端', icon: 'API', role: '接口与数据', key: 'backend', work: '开发接口、数据与事件流' },
  'reality-checker': { name: 'QA智能体', tag: 'QA', icon: '✓', role: '质量与回归', key: 'qa', work: '执行冒烟、回归与门禁验收' }
};

function runSessions() {
  try {
    const out = execSync('openclaw sessions --all-agents --json', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000
    });
    return JSON.parse(out);
  } catch {
    return { sessions: [] };
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}


function toStatus(s) {
  if (s.abortedLastRun) return '异常';
  if ((s.ageMs || 0) > 30 * 60 * 1000) return '空闲';
  return '运行中';
}

function toProgress(ageMs = 0) {
  const mins = Math.max(1, Math.floor(ageMs / 60000));
  return Math.max(8, Math.min(95, 100 - mins * 3));
}

let quotaCache = { ts: 0, left5h: 46, leftDay: 42, lastAttemptTs: 0 };
let quotaFetchInFlight = false;

function fetchRealQuota() {
  const now = Date.now();

  // 直接返回缓存，页面不阻塞
  const cached = quotaCache;

  // 5分钟刷新一次；且防抖20秒
  const stale = (now - quotaCache.ts) > 60 * 1000;
  const canTry = (now - (quotaCache.lastAttemptTs || 0)) > 10 * 1000;

  if (stale && canTry && !quotaFetchInFlight) {
    quotaFetchInFlight = true;
    quotaCache.lastAttemptTs = now;

    try {
      const row = latestSessionForAgent('rapid-prototyper');
      const args = ['agent', '--agent', 'rapid-prototyper'];
      if (row?.sessionId) args.push('--session-id', row.sessionId);
      args.push('--message', '📊 session_status', '--json', '--thinking', 'off', '--timeout', '25');

      const child = spawn('openclaw', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.on('close', () => {
        try {
          const out = JSON.parse(stdout || '{}');
          const text = (((out || {}).result || {}).payloads || []).map(p => p.text || '').join('\n');
          const m5 = text.match(/(?:5小时|5h)[^\n]*?(\d+)%/i);
          const mDay = text.match(/(?:每日|Day)[^\n]*?(\d+)%/i);
          const left5h = m5 ? Number(m5[1]) : null;
          const leftDay = mDay ? Number(mDay[1]) : null;
          if (left5h != null && leftDay != null) {
            quotaCache = { ts: Date.now(), left5h, leftDay, lastAttemptTs: quotaCache.lastAttemptTs };
          }
        } catch {}
        quotaFetchInFlight = false;
      });
      child.on('error', () => { quotaFetchInFlight = false; });
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} quotaFetchInFlight = false; }, 8000);
    } catch {
      quotaFetchInFlight = false;
    }
  }

  return cached;
}

function latestSessionForAgent(agentId) {
  const store = `/root/.openclaw/agents/${agentId}/sessions/sessions.json`;
  const data = readJson(store) || {};
  const rows = Object.entries(data)
    .filter(([k]) => k.startsWith(`agent:${agentId}:`))
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return rows[0] || null;
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  const lines = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' && part.text) lines.push(part.text);
  }
  return lines.join('\n').trim();
}

function readHistory(agentKey, limit = 40) {
  if (agentKey === 'all') return { messages: [], sessionId: null };
  const agentId = AGENT_IDS[agentKey];
  if (!agentId) return { messages: [], sessionId: null };
  const row = latestSessionForAgent(agentId);
  if (!row || !row.sessionFile || !fs.existsSync(row.sessionFile)) {
    return { messages: [], sessionId: row?.sessionId || null };
  }
  const lines = fs.readFileSync(row.sessionFile, 'utf8').split('\n').filter(Boolean);
  const parsed = [];
  for (const ln of lines) {
    try {
      const j = JSON.parse(ln);
      let role = j.role || 'unknown';
      let content = j.content;
      let ts = j.timestamp || Date.now();

      // new session event schema: {type:'message', message:{role, content, timestamp}}
      if (j.type === 'message' && j.message && typeof j.message === 'object') {
        role = j.message.role || role;
        content = j.message.content;
        ts = j.message.timestamp || ts;
      }

      if (role === 'toolResult' || role === 'toolCall') continue;
      const text = extractText(content);
      if (!text) continue;
      parsed.push({ role, text, ts });
    } catch {}
  }
  return { messages: parsed.slice(-limit), sessionId: row.sessionId || null };
}

function sendToAgent(agentKey, text) {
  const agentId = AGENT_IDS[agentKey];
  if (!agentId) return { ok: false, error: 'agent_not_found' };
  const row = latestSessionForAgent(agentId);
  const args = ['agent', '--agent', agentId];
  if (row?.sessionId) args.push('--session-id', row.sessionId);
  args.push('--message', text, '--json', '--thinking', 'off', '--timeout', '120');

  const run = spawnSync('openclaw', args, { encoding: 'utf8', timeout: 130000 });
  if (run.status !== 0) {
    return { ok: false, error: run.stderr?.slice(0, 500) || 'send_failed' };
  }

  const raw = run.stdout || '';
  let replyText = '';
  try {
    const parsed = JSON.parse(raw);
    const payloads = parsed?.result?.payloads || [];
    replyText = (payloads.find(p => p?.text)?.text || '').trim();
  } catch {}

  return { ok: true, replyText, raw: raw.slice(0, 800) };
}

function buildDashboard() {
  const raw = runSessions();
  const focus = ['rapid-prototyper', 'frontend-developer', 'backend-architect', 'reality-checker'];
  const sessions = (raw.sessions || []).filter(s => focus.includes(s.agentId));

  const latest = {};
  for (const s of sessions) if (!latest[s.agentId] || s.updatedAt > latest[s.agentId].updatedAt) latest[s.agentId] = s;

  const quota = fetchRealQuota();

  const cards = focus.map(id => {
    const s = latest[id] || { ageMs: 999999999, key: '-', updatedAt: Date.now(), abortedLastRun: false };
    const m = AGENT_META[id];
    const total = Number(s.totalTokens || 0);
    const ctx = Number(s.contextTokens || 200000);
    const usedPct = Math.max(0, Math.min(100, ctx ? Math.round((total / ctx) * 100) : 0));
    const remainPct = Math.max(0, 100 - usedPct);

    return {
      ...m,
      status: toStatus(s),
      progress: toProgress(s.ageMs),
      line1: toStatus(s) === '空闲' ? '当前状态：空闲（待分配任务）' : `当前处理：${m.work}`,
      line2: `模型：${s.model || 'gpt-5.3-codex'}`,
      runtime: `最近活跃 ${Math.floor((s.ageMs || 0) / 1000)} 秒前`,
      updatedAt: s.updatedAt || 0,
      debugKey: s.key,
      tokenUsedPct: id === "rapid-prototyper" && quota.leftDay != null ? (100 - quota.leftDay) : usedPct,
      tokenRemainPct: id === "rapid-prototyper" && quota.leftDay != null ? quota.leftDay : remainPct,
      quota5hLeftPct: id === "rapid-prototyper" ? quota.left5h : null,
      quotaDayLeftPct: id === "rapid-prototyper" ? quota.leftDay : null,
      tokenUsed: total,
      tokenContext: ctx
    };
  });

  const control = cards[0];
  const exec = cards.slice(1);
  const activity = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10).map(s => ({
    agentId: s.agentId,
    name: AGENT_META[s.agentId]?.name || s.agentId,
    status: toStatus(s),
    text: toStatus(s) === '空闲' ? '当前空闲，等待分配任务' : `正在处理：${AGENT_META[s.agentId]?.work || '执行中'}`,
    time: new Date(s.updatedAt).toLocaleTimeString('zh-CN')
  }));

  const summary = {
    blocked: cards.filter(c => c.status === '异常').length,
    unassigned: 0,
    review: cards.filter(c => c.status === '运行中').length,
    idle: cards.filter(c => c.status === '空闲').length,
    errors: cards.filter(c => c.status === '异常').length
  };

  return { control, exec, activity, summary, ts: Date.now() };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(obj));
}

function serveFile(reqPath, res) {
  const filePath = path.join(ROOT, reqPath === '/' ? '/index.html' : reqPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/dashboard') return sendJson(res, 200, buildDashboard());

  if (url.pathname === '/api/history') {
    const agent = url.searchParams.get('agent') || 'all';
    return sendJson(res, 200, readHistory(agent, 50));
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { agent, text } = JSON.parse(body || '{}');
        if (!text || !agent) return sendJson(res, 400, { ok: false, error: 'invalid_payload' });
        if (agent === 'all') return sendJson(res, 400, { ok: false, error: '请选择单个智能体对话' });
        const result = sendToAgent(agent, text);
        return sendJson(res, result.ok ? 200 : 500, result);
      } catch {
        return sendJson(res, 400, { ok: false, error: 'bad_json' });
      }
    });
    return;
  }

  serveFile(url.pathname, res);
}).listen(PORT, () => {
  console.log(`Agent Dev Control running at http://127.0.0.1:${PORT}`);
});
