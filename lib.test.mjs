import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, buildDeck, nonEpicParents } from './lib.mjs';

const line = (o) => JSON.stringify(o) + '\n';
const base = { sessionId: 's', cwd: '/w/repo', timestamp: '2026-01-01T00:00:00.000Z' };

test('key found from each signal separately', () => {
  const branch = parseTranscript(line({ ...base, gitBranch: 'feat/proj-11-x' }), 'a');
  const custom = parseTranscript(line({ type: 'custom-title', customTitle: 'PROJ-22 work' }), 'b');
  const ai = parseTranscript(line({ type: 'ai-title', aiTitle: 'Fix PROJ-33 bug' }), 'c');
  const cmd = parseTranscript(line({ ...base, message: '<command-name>/ticket</command-name>\n<command-args>PROJ-44</command-args>' }), 'd');
  assert.deepEqual(branch.keys, ['PROJ-11']);
  assert.deepEqual(custom.keys, ['PROJ-22']);
  assert.deepEqual(ai.keys, ['PROJ-33']);
  assert.deepEqual(cmd.keys, ['PROJ-44']);
});

const issue = (key) => ({ key, fields: { summary: 's', status: { name: 'x', statusCategory: { key: 'new' } }, issuetype: { name: 'Bug' } } });

test('PROJ-3069 does not link to a PROJ-30696 session', () => {
  const s = parseTranscript(line({ ...base, gitBranch: 'fix/PROJ-30696' }), 'a');
  const deck = buildDeck([issue('PROJ-3069')], [], [s], 'https://j');
  assert.equal(deck.tickets[0].sessions.length, 0);
  assert.equal(deck.unlinked.length, 1);
});

test('PR attaches via prUrls when branch and title lack the key', () => {
  const s = parseTranscript(line({ ...base, gitBranch: 'PROJ-5-x' }) + line({ type: 'pr-link', prUrl: 'https://github.com/o/r/pull/9' }), 'a');
  const pr = { url: 'https://github.com/o/r/pull/9', branch: 'misc', title: 'misc' };
  const deck = buildDeck([issue('PROJ-5')], [pr, { url: 'u2', branch: 'b', title: 't' }], [s], 'https://j');
  assert.deepEqual(deck.tickets[0].prs, [pr]);
});

test('a ticket takes its epic from its parent, and a sub-task from its parent story', () => {
  const epicParent = { key: 'PROJ-1', fields: { summary: 'Epic one', issuetype: { name: 'Epic' } } };
  const storyParent = { key: 'PROJ-2', fields: { summary: 'Story two', issuetype: { name: 'Story' } } };
  const mk = (key, parent, type = 'Story') => ({ key, fields: { summary: key, status: { name: 'S', statusCategory: { key: 'new' } }, issuetype: { name: type }, parent } });
  const issues = [mk('PROJ-10', epicParent), mk('PROJ-11', storyParent, 'Sub-task'), mk('PROJ-12'), mk('PROJ-1', undefined, 'Epic')];
  assert.deepEqual(nonEpicParents(issues), ['PROJ-2']);
  const [child, sub, loose, epic] = buildDeck(issues, [], [], 'https://j', { 'PROJ-2': { key: 'PROJ-1', title: 'Epic one' } }).tickets;
  assert.deepEqual(child.epic, { key: 'PROJ-1', title: 'Epic one', url: 'https://j/browse/PROJ-1' });
  assert.equal(child.parent, null);
  assert.equal(sub.epic.key, 'PROJ-1');
  assert.equal(sub.parent.key, 'PROJ-2');
  assert.equal(loose.epic, null);
  assert.equal(epic.isEpic, true);
});
