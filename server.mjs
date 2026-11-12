import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, buildDeck, nonEpicParents, normalizePr, safeSummary, KEY_RE, UUID_RE } from './lib.mjs';

const run = promisify(execFile);
const PORT = Number(process.env.PORT) || 4747;
const CLAUDE = join(homedir(), '.claude');
const cache = new Map();
let lastDeck = null;

async function scanSessions() {
  const projects = join(CLAUDE, 'projects');
  const files = [];
  for (const d of await readdir(projects)) {
    if (d.includes('-private-var-folders-')) continue;
    try {
      for (const f of await readdir(join(projects, d))) if (f.endsWith('.jsonl')) files.push(join(projects, d, f));
    } catch {}
  }
  const out = [];
  const seen = new Set(files);
  for (const p of cache.keys()) if (!seen.has(p)) cache.delete(p);
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const p = files[i++];
      try {
        const st = await stat(p);
        const sig = `${st.mtimeMs}:${st.size}`;
        let hit = cache.get(p);
        if (hit?.sig !== sig) {
          const id = p.slice(p.lastIndexOf('/') + 1, -6);
          const rec = parseTranscript(await readFile(p, 'utf8'), id);
          rec.lastActive ||= st.mtime.toISOString();
          hit = { sig, rec };
          cache.set(p, hit);
        }
        out.push(hit.rec);
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  const live = new Map();
  try {
    for (const f of await readdir(join(CLAUDE, 'sessions'))) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await readFile(join(CLAUDE, 'sessions', f), 'utf8'));
        process.kill(j.pid, 0);
        live.set(j.sessionId, { status: j.status ?? 'unknown', name: j.name ?? '' });
      } catch {}
    }
  } catch {}
  return out.filter((s) => s.cwd).map((s) => ({ ...s, live: live.get(s.id) ?? null }));
}

async function jget(path, params) {
  const env = {};
  for (const l of (await readFile(join(homedir(), '.jira-env'), 'utf8')).split('\n')) {
    const m = l.match(/^\s*(?:export\s+)?(\w+)=(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const base = env.JIRA_BASE.replace(/\/+$/, '');
  const r = await fetch(`${base}${path}?` + new URLSearchParams(params), {
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64'), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { base, body: await r.json() };
}

const MINE = 'assignee = currentUser() AND statusCategory != Done';
const FIELDS = 'summary,status,issuetype,parent';

async function jira(board) {
  if (!board) {
    const { base, body } = await jget('/rest/api/3/search/jql', { jql: MINE + ' ORDER BY updated DESC', fields: FIELDS, maxResults: '100' });
    return { base, issues: body.issues, board: null };
  }
  const at = `/rest/agile/1.0/board/${board.id}`;
  // A Kanban board answers the sprint call with HTTP 400, which means "no sprint" here.
  const sprint = (await jget(`${at}/sprint`, { state: 'active' }).catch(() => null))?.body.values?.[0] ?? null;
  const filters = await Promise.all(board.qf.map((q) => jget(`${at}/quickfilter/${q}`, {})));
  const jql = [MINE, sprint && `sprint = ${sprint.id}`, ...filters.map((f) => `(${f.body.jql})`)].filter(Boolean).join(' AND ');
  const { base, body } = await jget(`${at}/issue`, { jql, fields: FIELDS, maxResults: '100' });
  return { base, issues: body.issues, board: { id: board.id, sprint: sprint && { name: sprint.name, endDate: sprint.endDate ?? null } } };
}

// A sub-task's parent is a story, so its epic is one level further up and needs its own lookup.
async function parentEpics(issues) {
  const keys = nonEpicParents(issues).filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k));
  if (!keys.length) return {};
  const { body } = await jget('/rest/api/3/search/jql', { jql: `key in (${keys.join(',')})`, fields: 'parent', maxResults: '100' });
  return Object.fromEntries(body.issues.filter((i) => i.fields.parent).map((i) => [i.key, { key: i.fields.parent.key, title: i.fields.parent.fields?.summary ?? i.fields.parent.key }]));
}

async function boards(query) {
  const q = query.trim().slice(0, 300);
  const out = (base, b) => ({ id: String(b.id), name: b.name, type: b.type, projectKey: b.location?.projectKey ?? null, url: `${base}/secure/RapidBoard.jspa?rapidView=${b.id}` });
  const id = q.match(/\/boards\/(\d+)/)?.[1] ?? q.match(/rapidView=(\d+)/)?.[1] ?? q.match(/^\d+$/)?.[0];
  if (id) {
    const { base, body } = await jget(`/rest/agile/1.0/board/${id}`, {});
    return [out(base, body)];
  }
  if (!q) return [];
  const calls = [jget('/rest/agile/1.0/board', { name: q, maxResults: '20' })];
  if (/^[A-Za-z][A-Za-z0-9_]{1,19}$/.test(q)) calls.push(jget('/rest/agile/1.0/board', { projectKeyOrId: q.toUpperCase(), maxResults: '20' }).catch(() => null));
  const found = new Map();
  for (const r of (await Promise.all(calls)).filter(Boolean)) for (const b of r.body.values) found.set(b.id, out(r.base, b));
  return [...found.values()];
}

// ponytail: gh search takes 5-8s, so reuse it for 2 min; ?fresh=1 (Refresh button) bypasses
let ghCache = { at: 0, prs: null };
async function github(fresh) {
  if (!fresh && ghCache.prs && Date.now() - ghCache.at < 120000) return ghCache.prs;
  ghCache = { at: Date.now(), prs: await fetchPrs() };
  return ghCache.prs;
}

async function fetchPrs() {
  const query = `{search(query:"is:pr author:@me sort:updated-desc",type:ISSUE,first:100){nodes{... on PullRequest{number title url state isDraft reviewDecision headRefName repository{nameWithOwner} latestReviews(first:20){nodes{state}} reviewRequests{totalCount} reviewThreads(first:100){nodes{isResolved}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
  const { stdout } = await run('gh', ['api', 'graphql', '-f', 'query=' + query], { timeout: 30000, maxBuffer: 32e6 });
  return JSON.parse(stdout).data.search.nodes.filter((n) => n.url).map(normalizePr);
}

async function deck(fresh, board) {
  const errors = [];
  const [sessions, j, prs] = await Promise.all([
    scanSessions(),
    jira(board).catch((e) => (errors.push('Jira: ' + e.message.replace(/\s+/g, ' ').slice(0, 200)), { base: '', issues: [], board: null })),
    github(fresh).catch((e) => (errors.push('GitHub: ' + String(e.message).split('\n')[0].slice(0, 200)), [])),
  ]);
  const { tickets, unlinked } = buildDeck(j.issues, prs, sessions, j.base, await parentEpics(j.issues).catch(() => ({})));
  const cwds = [...new Set(sessions.map((s) => s.cwd))].filter(existsSync).sort();
  lastDeck = { tickets, sessions, cwds };
  return { tickets, unlinked, cwds, errors, board: j.board, terminal: !!(await wezterm()) };
}

// A server started from inside a Claude session would pass its child-session markers on, and the launched session would not save a transcript.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
const WEZ = process.env.WEZTERM_BIN ? [process.env.WEZTERM_BIN] : ['wezterm', '/Applications/WezTerm.app/Contents/MacOS/wezterm'];
let wez = { at: 0, bin: null };
async function wezterm() {
  if (Date.now() - wez.at < 60000) return wez.bin;
  let bin = null;
  for (const c of WEZ) if (await run(c, ['--version'], { timeout: 3000 }).then(() => true, () => false)) { bin = c; break; }
  wez = { at: Date.now(), bin };
  return bin;
}
// `cli spawn` needs a running WezTerm; `start` covers the case where it is closed.
async function terminal(cwd, cmd) {
  const bin = await wezterm();
  if (!bin) throw 'WezTerm not found';
  const tail = ['--cwd', cwd, '--', '/bin/zsh', '-lic', cmd];
  await run(bin, ['cli', 'spawn', '--new-window', ...tail], { env: cleanEnv, timeout: 5000 })
    .catch(() => void spawn(bin, ['start', ...tail], { env: cleanEnv, detached: true, stdio: 'ignore' }).on('error', () => {}).unref());
}

const actions = {
  async '/api/resume'({ sessionId }) {
    if (!UUID_RE.test(sessionId)) throw 'bad sessionId';
    const s = (await scanSessions()).find((x) => x.id === sessionId);
    if (!s || !existsSync(s.cwd)) throw 'unknown session';
    await terminal(s.cwd, 'claude --resume ' + s.id);
  },
  async '/api/new'({ key, cwd }) {
    const t = typeof key === 'string' && new RegExp(`^${KEY_RE.source}$`).test(key) && lastDeck?.tickets.find((x) => x.key === key);
    if (!t) throw 'unknown ticket';
    if (!lastDeck.cwds.includes(cwd)) throw 'unknown cwd';
    await terminal(cwd, `claude -n '${key} ${safeSummary(t.summary)}' '/ticket ${key}'`);
  },
};

const hostOk = (v) => v === `127.0.0.1:${PORT}` || v === `localhost:${PORT}`;

http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => (res.writeHead(code, { 'Content-Type': type }), res.end(typeof body === 'string' ? body : JSON.stringify(body)));
  try {
    if (!hostOk(req.headers.host)) return send(403, { error: 'bad host' });
    const { pathname: url, searchParams: qs } = new URL(req.url, 'http://deck');
    if (req.method === 'GET' && url === '/') return send(200, await readFile(new URL('./index.html', import.meta.url), 'utf8'),'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/deck') {
      const digits = (v) => /^\d{1,12}$/.test(v ?? '');
      const board = digits(qs.get('board')) ? { id: qs.get('board'), qf: (qs.get('qf') ?? '').split(',').filter(digits).slice(0, 10) } : null;
      return send(200, await deck(qs.get('fresh') === '1', board));
    }
    if (req.method === 'GET' && url === '/api/boards') return send(200, await boards(qs.get('q') ?? ''));
    if (req.method === 'POST' && actions[url]) {
      const o = req.headers.origin;
      if (o && !hostOk(o.replace(/^https?:\/\//, ''))) return send(403, { error: 'bad origin' });
      if (!o) return send(403, { error: 'origin required' });
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(415, { error: 'json only' });
      let body = '';
      for await (const c of req) if ((body += c).length > 4096) return send(413, { error: 'too large' });
      let data;
      try { data = JSON.parse(body); } catch { return send(400, { error: 'bad json' }); }
      try { await actions[url](data ?? {}); } catch (e) { return send(400, { error: typeof e === 'string' ? e : 'launch failed' }); }
      return send(200, { ok: true });
    }
    send(404, { error: 'not found' });
  } catch (e) {
    send(500, { error: String(e.message ?? e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}`));
