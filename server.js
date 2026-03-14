const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync, spawn, spawnSync } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 3131;

const OPENCLAW_PATH = path.join(process.env.HOME, '.openclaw');
const AGENTS_PATH = path.join(OPENCLAW_PATH, 'agents');
const CONFIG_PATH = path.join(OPENCLAW_PATH, 'openclaw.json');
const TASKS_PATH = path.join(process.env.HOME, '.sheldon-tasks.json');
const METRICS_PATH = path.join(process.env.HOME, '.sheldon-metrics.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── UTILS ──────────────────────────────────────────────────────────────────

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}
function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch { return ''; }
}
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
function getAgentDir(name) {
  return path.join(AGENTS_PATH, name, 'agent');
}

function isValidAgentName(name) {
  return typeof name === 'string' && /^[a-z0-9_-]+$/i.test(name);
}

// ── WEBSOCKET — LIVE LOGS ──────────────────────────────────────────────────

let logWatchers = new Set();

wss.on('connection', (ws) => {
  logWatchers.add(ws);
  ws.on('close', () => logWatchers.delete(ws));
});

function broadcastLog(msg) {
  logWatchers.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', data: msg }));
  });
}

// Watch log file for changes
function startLogWatcher() {
  try {
    const logsDir = path.join(OPENCLAW_PATH, 'logs');
    if (!fs.existsSync(logsDir)) return;
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') || f.endsWith('.jsonl')).sort().reverse();
    if (!files.length) return;
    const latest = path.join(logsDir, files[0]);
    let lastSize = fs.statSync(latest).size;
    setInterval(() => {
      try {
        const stat = fs.statSync(latest);
        if (stat.size > lastSize) {
          const fd = fs.openSync(latest, 'r');
          const buf = Buffer.alloc(stat.size - lastSize);
          fs.readSync(fd, buf, 0, buf.length, lastSize);
          fs.closeSync(fd);
          broadcastLog(buf.toString('utf8'));
          lastSize = stat.size;
        }
      } catch {}
    }, 1000);
  } catch {}
}
startLogWatcher();

// ── METRICS ───────────────────────────────────────────────────────────────

function getMetrics() {
  const defaults = {
    totalRequests: 0, totalTokensIn: 0, totalTokensOut: 0,
    estimatedCost: 0, agentCalls: {}, dailyActivity: [], lastUpdated: null
  };
  return readJSON(METRICS_PATH) || defaults;
}

function saveMetrics(m) { writeJSON(METRICS_PATH, m); }

function recordMetric(agent, tokensIn = 0, tokensOut = 0) {
  const m = getMetrics();
  m.totalRequests++;
  m.totalTokensIn += tokensIn;
  m.totalTokensOut += tokensOut;
  // Rough cost estimate: haiku ~$0.001/1k tokens, sonnet ~$0.015/1k
  const cost = (tokensIn * 0.000001) + (tokensOut * 0.000002);
  m.estimatedCost += cost;
  m.agentCalls[agent] = (m.agentCalls[agent] || 0) + 1;
  const today = new Date().toISOString().split('T')[0];
  const dayEntry = m.dailyActivity.find(d => d.date === today);
  if (dayEntry) dayEntry.calls++;
  else m.dailyActivity.push({ date: today, calls: 1 });
  m.dailyActivity = m.dailyActivity.slice(-30); // keep 30 days
  m.lastUpdated = new Date().toISOString();
  saveMetrics(m);
}

app.get('/api/metrics', (req, res) => res.json(getMetrics()));
app.post('/api/metrics/reset', (req, res) => {
  saveMetrics({ totalRequests:0, totalTokensIn:0, totalTokensOut:0, estimatedCost:0, agentCalls:{}, dailyActivity:[], lastUpdated:null });
  res.json({ success: true });
});

// ── GATEWAY ───────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  try {
    const result = execSync('openclaw gateway status 2>&1', { encoding: 'utf8', timeout: 5000 });
    const running = result.toLowerCase().includes('running') || result.toLowerCase().includes('active');
    res.json({ running, output: result.trim() });
  } catch (e) { res.json({ running: false, output: e.message }); }
});

app.post('/api/gateway/:action', (req, res) => {
  const { action } = req.params;
  if (!['restart', 'stop', 'start'].includes(action)) return res.status(400).json({ error: 'Invalid' });
  try {
    const result = execSync(`openclaw gateway ${action} 2>&1`, { encoding: 'utf8', timeout: 10000 });
    res.json({ success: true, output: result.trim() });
  } catch (e) { res.json({ success: false, output: e.message }); }
});

// ── AGENTS ────────────────────────────────────────────────────────────────

app.get('/api/agents', (req, res) => {
  try {
    const agents = fs.readdirSync(AGENTS_PATH)
      .filter(f => fs.statSync(path.join(AGENTS_PATH, f)).isDirectory());
    const data = agents.map(name => {
      const dir = getAgentDir(name);
      const agentJson = readJSON(path.join(dir, 'agent.json')) || {};
      const systemMd = readFile(path.join(dir, 'system.md'));
      return { name, model: agentJson.model || 'unknown', systemPrompt: systemMd, agentJson };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agents/:name/system', (req, res) => {
  if (!isValidAgentName(req.params.name)) return res.status(400).json({ error: 'Invalid agent name' });
  const filePath = path.join(getAgentDir(req.params.name), 'system.md');
  try { writeFile(filePath, req.body.content); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/agents/:name/model', (req, res) => {
  if (!isValidAgentName(req.params.name)) return res.status(400).json({ error: 'Invalid agent name' });
  const filePath = path.join(getAgentDir(req.params.name), 'agent.json');
  try {
    const existing = readJSON(filePath) || {};
    existing.model = req.body.model;
    writeJSON(filePath, existing);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents', (req, res) => {
  const { name, model, systemPrompt, role } = req.body;
  if (!name || !model) return res.status(400).json({ error: 'name and model required' });
  if (!isValidAgentName(name)) return res.status(400).json({ error: 'Agent name must be alphanumeric with hyphens/underscores only' });
  const dir = getAgentDir(name);
  if (fs.existsSync(dir)) return res.status(400).json({ error: 'Agent already exists' });
  try {
    fs.mkdirSync(dir, { recursive: true });
    const mainAuth = path.join(getAgentDir('main'), 'auth-profiles.json');
    if (fs.existsSync(mainAuth)) fs.copyFileSync(mainAuth, path.join(dir, 'auth-profiles.json'));
    writeJSON(path.join(dir, 'agent.json'), { model, name, role: role || name });
    const sys = systemPrompt || `# ${name} Agent\n\nYou are the ${name} specialist for Andres's Clawmark agency.\n\n## Role\n${role || 'Specialist agent'}\n\n## Instructions\n- Be concise\n- Deliver results clearly\n- Stay within your specialty\n`;
    writeFile(path.join(dir, 'system.md'), sys);
    res.json({ success: true, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/agents/:name', (req, res) => {
  if (req.params.name === 'main') return res.status(400).json({ error: 'Cannot delete main agent' });
  if (!isValidAgentName(req.params.name)) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    fs.rmSync(path.join(AGENTS_PATH, req.params.name), { recursive: true, force: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHAT ──────────────────────────────────────────────────────────────────

const chatHistory = [];

app.get('/api/chat/history', (req, res) => res.json(chatHistory.slice(-50)));

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  chatHistory.push({ role: 'user', content: message, ts: new Date().toISOString() });

  try {
    const proc = spawnSync('openclaw', ['agent', '--agent', 'main', '--message', message, '--json'], {
      encoding: 'utf8', timeout: 60000
    });
    const raw = (proc.stdout || proc.stderr || '').trim();
    let reply = raw;
    try {
      const j = JSON.parse(raw);
      reply = j?.result?.payloads?.[0]?.text || j.reply || j.output || j.text || raw;
    } catch {}
    reply = reply || 'No response';
    chatHistory.push({ role: 'sheldon', content: reply, ts: new Date().toISOString() });
    recordMetric('main', message.length / 4, reply.length / 4);
    res.json({ reply });
  } catch (e) {
    // Fallback: openclaw chat might not exist, return error gracefully
    const errMsg = `⚠️ Could not reach Sheldon via CLI. Make sure the gateway is running and try messaging via Telegram. Error: ${e.message.split('\n')[0]}`;
    chatHistory.push({ role: 'sheldon', content: errMsg, ts: new Date().toISOString() });
    res.json({ reply: errMsg });
  }
});

// ── TASKS ─────────────────────────────────────────────────────────────────

function getTasks() { return readJSON(TASKS_PATH) || []; }
function saveTasks(t) { writeJSON(TASKS_PATH, t); }

app.get('/api/tasks', (req, res) => res.json(getTasks()));

app.post('/api/tasks', (req, res) => {
  const { title, description, agent, priority, project } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const tasks = getTasks();
  const task = {
    id: Date.now().toString(),
    title, description: description || '', agent: agent || 'main',
    priority: priority || 'medium', project: project || 'Clawmark',
    status: 'todo', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  tasks.push(task);
  saveTasks(tasks);
  res.json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const tasks = getTasks();
  const idx = tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  tasks[idx] = { ...tasks[idx], ...req.body, updatedAt: new Date().toISOString() };
  saveTasks(tasks);
  res.json(tasks[idx]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const tasks = getTasks().filter(t => t.id !== req.params.id);
  saveTasks(tasks);
  res.json({ success: true });
});

// ── SKILLS ────────────────────────────────────────────────────────────────

app.get('/api/skills', (req, res) => {
  try {
    const result = execSync('openclaw skills list 2>&1', { encoding: 'utf8', timeout: 5000 });
    res.json({ output: result.trim() });
  } catch (e) { res.json({ output: e.message }); }
});

app.post('/api/skills/install', (req, res) => {
  const { skill } = req.body;
  if (!skill) return res.status(400).json({ error: 'skill name required' });
  if (!/^[a-z0-9_-]+$/i.test(skill)) return res.status(400).json({ error: 'Invalid skill name' });
  try {
    const proc = spawnSync('openclaw', ['skills', 'install', skill], { encoding: 'utf8', timeout: 30000 });
    const output = (proc.stdout || proc.stderr || '').trim();
    res.json({ success: proc.status === 0, output });
  } catch (e) { res.json({ success: false, output: e.message }); }
});

// ── LOGS ──────────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  try {
    const logsDir = path.join(OPENCLAW_PATH, 'logs');
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log') || f.endsWith('.jsonl')).sort().reverse();
    if (!files.length) return res.json({ logs: '', file: '' });
    const latest = path.join(logsDir, files[0]);
    const raw = fs.readFileSync(latest, 'utf8');
    const content = raw.split('\n').slice(-150).join('\n');
    res.json({ logs: content, file: files[0] });
  } catch (e) { res.json({ logs: e.message, file: '' }); }
});

// ── CONFIG ────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const config = readJSON(CONFIG_PATH);
  if (!config) return res.status(500).json({ error: 'Could not read config' });
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.apiKey) safe.apiKey = '••••' + safe.apiKey.slice(-4);
  if (safe.perplexityKey) safe.perplexityKey = '••••' + safe.perplexityKey.slice(-4);
  res.json(safe);
});

// ── START ─────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`\n🦞 Sheldon Control Panel v2 → http://localhost:${PORT}\n`);
});
