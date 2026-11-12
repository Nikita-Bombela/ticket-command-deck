import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTranscript, buildDeck, normalizePr, safeSummary, KEY_RE, UUID_RE } from './lib.mjs';

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

async function jira() {
  const env = {};
  for (const l of (await readFile(join(homedir(), '.jira-env'), 'utf8')).split('\n')) {
    const m = l.match(/^\s*(?:export\s+)?(\w+)=(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const base = env.JIRA_BASE.replace(/\/+$/, '');
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const r = await fetch(`${base}/rest/api/3/search/jql?` + new URLSearchParams({ jql, fields: 'summary,status,issuetype', maxResults: '100' }), {
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_TOKEN}`).toString('base64'), Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return { base, issues: (await r.json()).issues };
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

async function deck(fresh) {
  const errors = [];
  const [sessions, j, prs] = await Promise.all([
    scanSessions(),
    jira().catch((e) => (errors.push('Jira: ' + e.message.replace(/\s+/g, ' ').slice(0, 200)), { base: '', issues: [] })),
    github(fresh).catch((e) => (errors.push('GitHub: ' + String(e.message).split('\n')[0].slice(0, 200)), [])),
  ]);
  const { tickets, unlinked } = buildDeck(j.issues, prs, sessions, j.base);
  const cwds = [...new Set(sessions.map((s) => s.cwd))].filter(existsSync).sort();
  lastDeck = { tickets, sessions, cwds };
  return { tickets, unlinked, cwds, errors };
}

// A server started from inside a Claude session would pass its child-session markers on, and the launched session would not save a transcript.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
// `cli spawn` needs a running WezTerm; `start` covers the case where it is closed.
const terminal = (cwd, cmd) => {
  const tail = ['--cwd', cwd, '--', '/bin/zsh', '-lic', cmd];
  return run('wezterm', ['cli', 'spawn', '--new-window', ...tail], { env: cleanEnv, timeout: 5000 })
    .catch(() => void spawn('wezterm', ['start', ...tail], { env: cleanEnv, detached: true, stdio: 'ignore' }).unref());
};

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
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') return send(200, await readFile(new URL('./index.html', import.meta.url), 'utf8'),'text/html; charset=utf-8');
    if (req.method === 'GET' && url === '/api/deck') return send(200, await deck(req.url.includes('fresh=1')));
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
