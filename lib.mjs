export const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const keysIn = (s) => new Set((String(s).toUpperCase().match(KEY_RE) ?? []));

const unescape = (s) => { try { return JSON.parse('"' + s + '"'); } catch { return s; } };
const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

export function parseTranscript(text, id) {
  const branches = [];
  for (const b of all(text, /"gitBranch":"([^"]*)"/g).map(unescape)) {
    const i = branches.indexOf(b);
    if (i >= 0) branches.splice(i, 1);
    branches.push(b);
  }
  const customs = all(text, /"customTitle":"((?:[^"\\]|\\.)*)"/g).map(unescape);
  const ais = all(text, /"aiTitle":"((?:[^"\\]|\\.)*)"/g).map(unescape);
  const args = all(text, /<command-name>\/ticket<\/command-name>[\s\S]{0,300}?<command-args>([^<]*)<\/command-args>/g);
  // The Claude app turns the slash of a prefilled "/ticket" into a look-alike so that links cannot run commands, hence the sentence form.
  const marks = all(text, /"(?:content|text)":"Link this session to Jira ticket\s+([A-Za-z][A-Za-z0-9]+-\d+)/gi);
  const keys = new Set();
  for (const s of [...branches, customs.at(-1), ais.at(-1), ...args, ...marks]) if (s) for (const k of keysIn(s)) keys.add(k);
  const ts = text.lastIndexOf('"timestamp":"');
  return {
    id,
    cwd: text.match(/"cwd":"([^"]*)"/)?.[1] ?? null,
    title: customs.at(-1) || ais.at(-1) || '(untitled)',
    branches,
    keys: [...keys],
    prUrls: [...new Set(all(text, /"prUrl":"([^"]*)"/g))],
    lastActive: ts >= 0 ? text.slice(ts + 13, ts + 37).replace(/".*/, '') : null,
    live: null,
  };
}

const isEpicType = (it) => (it?.hierarchyLevel ?? (it?.name === 'Epic' ? 1 : 0)) === 1;
export const nonEpicParents = (issues) =>
  [...new Set(issues.map((i) => i.fields.parent).filter((p) => p && !isEpicType(p.fields?.issuetype)).map((p) => p.key))];

export function buildDeck(issues, prs, sessions, jiraBase, parentEpics = {}) {
  const link = (key, title) => ({ key, title, url: `${jiraBase}/browse/${key}` });
  const tickets = issues.map((i) => {
    const mine = sessions.filter((s) => s.keys.includes(i.key)).sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
    const urls = new Set(mine.flatMap((s) => s.prUrls));
    const p = i.fields.parent, direct = p && isEpicType(p.fields?.issuetype), viaParent = p && parentEpics[p.key];
    return {
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status.name,
      statusCategory: i.fields.status.statusCategory.key,
      type: i.fields.issuetype.name,
      isEpic: isEpicType(i.fields.issuetype),
      epic: direct ? link(p.key, p.fields.summary) : viaParent ? link(viaParent.key, viaParent.title) : null,
      parent: p && !direct ? link(p.key, p.fields?.summary ?? p.key) : null,
      url: `${jiraBase}/browse/${i.key}`,
      prs: prs.filter((p) => urls.has(p.url) || keysIn(p.branch).has(i.key) || keysIn(p.title).has(i.key)),
      sessions: mine,
    };
  });
  const linked = new Set(tickets.flatMap((t) => t.sessions.map((s) => s.id)));
  const unlinked = sessions.filter((s) => !linked.has(s.id)).sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''));
  return { tickets, unlinked };
}

export function normalizePr(n, viewer) {
  const r = (st) => n.latestReviews.nodes.filter((x) => x.state === st).length;
  return {
    repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, state: n.state,
    isDraft: n.isDraft, reviewDecision: n.reviewDecision,
    reviews: { approved: r('APPROVED'), changesRequested: r('CHANGES_REQUESTED'), commented: r('COMMENTED') },
    reviewRequests: n.reviewRequests.totalCount,
    unresolved: n.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    checks: n.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    branch: n.headRefName,
    author: n.author?.login ?? null,
    mine: !viewer || n.author?.login === viewer,
  };
}

export const safeSummary = (s) => String(s).replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60);

const JIRA_NAMES = {
  JIRA_BASE: ['JIRA_BASE', 'JIRA_DOMAIN', 'JIRA_URL', 'JIRA_HOST'],
  JIRA_EMAIL: ['JIRA_EMAIL', 'JIRA_USER_EMAIL', 'JIRA_USER'],
  JIRA_TOKEN: ['JIRA_TOKEN', 'JIRA_API_TOKEN'],
};
export function parseJiraEnv(text) {
  const env = {};
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*(?:export\s+)?(\w+)=(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  const value = (name) => JIRA_NAMES[name].map((n) => env[n]).find(Boolean);
  const missing = Object.keys(JIRA_NAMES).filter((n) => !value(n));
  const host = (value('JIRA_BASE') ?? '').replace(/\/+$/, '');
  return { base: host && !/^https?:\/\//.test(host) ? 'https://' + host : host, email: value('JIRA_EMAIL'), token: value('JIRA_TOKEN'), missing };
}
