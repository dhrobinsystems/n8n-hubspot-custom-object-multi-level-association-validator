#!/usr/bin/env node
/**
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-custom-object-multi-level-association-validator.
 *
 * Reads workflow.json (the exact file you import into n8n), walks the node
 * graph from "Manual Test Trigger", and executes every Code node in plain
 * Node.js with n8n-compatible globals ($input, $env, $(), $execution).
 * IF nodes are evaluated with strict boolean checks; "Execute Once" and the
 * HTTP node's body-parameter pagination are emulated. HTTP Request nodes
 * NEVER touch the network: reaching one is a failure unless --mock-live is
 * set, in which case an in-memory HubSpot built from the fixture answers.
 *
 * Usage:
 *   node scripts/simulate-sandbox-run.js                       # sandbox defaults (no env)
 *   node scripts/simulate-sandbox-run.js --mock-live           # full live path, mocked HubSpot + Slack
 *   node scripts/simulate-sandbox-run.js --mock-live --fail-writes          # remediation 429 path
 *   node scripts/simulate-sandbox-run.js --mock-live --set MAX_MUTATIONS_PER_RUN=2   # guard trips
 *   node scripts/simulate-sandbox-run.js --mock-live --set SEARCH_MAX_PAGES=1       # truncated search
 *   node scripts/simulate-sandbox-run.js --block-env           # N8N_BLOCK_ENV_ACCESS_IN_NODE=true
 *   node scripts/simulate-sandbox-run.js --env-file .env       # load a dotenv file (secrets masked)
 *   node scripts/simulate-sandbox-run.js --fixture path/to/fixture.json --no-checks
 *   Options: --page-size <n> (mock search page size, default 3), --json, --quiet,
 *            --no-checks, --out <file>, --set KEY=VALUE (repeatable)
 *
 * Requires Node.js >= 18. No dependencies.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const DEFAULT_FIXTURE = path.join(ROOT, 'sample-payloads', 'hubspot-association-hierarchy-fixture.json');
const SECRET_KEYS = ['HUBSPOT_ACCESS_TOKEN', 'SLACK_ALERT_WEBHOOK_URL', 'ALERT_WEBHOOK_URL'];

// ── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = { set: [], envFile: null, fixture: null, mockLive: false, failWrites: false, blockEnv: false, json: false, quiet: false, checks: true, pageSize: 3, out: path.join(ROOT, 'sim-output', 'last-run.json') };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--mock-live') opt.mockLive = true;
  else if (a === '--fail-writes') opt.failWrites = true;
  else if (a === '--block-env') opt.blockEnv = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--no-checks') opt.checks = false;
  else if (a === '--env-file') opt.envFile = args[++i];
  else if (a === '--fixture') opt.fixture = args[++i];
  else if (a === '--page-size') opt.pageSize = Math.max(1, parseInt(args[++i], 10) || 3);
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--set') opt.set.push(args[++i]);
  else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 30).join('\n')); process.exit(0); }
  else { console.error(`Unknown argument: ${a}`); process.exit(2); }
}
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const ok = (s) => color('32', s); const bad = (s) => color('31', s); const dim = (s) => color('2', s); const bold = (s) => color('1', s);
const log = (...a) => { if (!opt.quiet) console.log(...a); };

// ── Load workflow + fixture ────────────────────────────────────────────────
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const wfText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const fixturePath = opt.fixture ? path.resolve(opt.fixture) : DEFAULT_FIXTURE;
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const usingDefaultFixture = fixturePath === DEFAULT_FIXTURE;
const nodesByName = new Map(workflow.nodes.map((n) => [n.name, n]));

// ── Isolated environment: host process.env is NEVER passed through ──────────
const env = {};
const parseDotenv = (text) => {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
};
if (opt.envFile) parseDotenv(fs.readFileSync(path.resolve(opt.envFile), 'utf8'));
if (opt.mockLive) {
  const lv = fixture.graph.levels;
  Object.assign(env, {
    SANDBOX_MODE: 'false', DRY_RUN: 'false', HUBSPOT_MUTATIONS_ENABLED: 'true', SEND_SLACK_ALERTS: 'true', SEND_OPS_ALERTS: 'true',
    REMEDIATION_ACTIONS: 'create_missing_association,archive_dangling_association,flag_records',
    HUBSPOT_ACCESS_TOKEN: 'mock-hubspot-token-not-real',
    SLACK_ALERT_WEBHOOK_URL: 'https://hooks.example.com/mock/slack-integrity-alerts',
    ALERT_WEBHOOK_URL: 'https://alerts.example.com/mock/ops',
    HUBSPOT_PARENT_OBJECT_TYPE: lv.parent.objectType, HUBSPOT_PARENT_OBJECT_TYPE_ID: lv.parent.objectTypeId,
    HUBSPOT_CHILD_OBJECT_TYPE: lv.child.objectType, HUBSPOT_CHILD_OBJECT_TYPE_ID: lv.child.objectTypeId,
    HUBSPOT_ASSET_OBJECT_TYPE: lv.asset.objectType, HUBSPOT_ASSET_OBJECT_TYPE_ID: lv.asset.objectTypeId,
  });
}
for (const kv of opt.set) {
  const i = kv.indexOf('=');
  if (i < 1) { console.error(`--set expects KEY=VALUE, got "${kv}"`); process.exit(2); }
  env[kv.slice(0, i)] = kv.slice(i + 1);
}
const secretValues = SECRET_KEYS.map((k) => env[k]).filter((v) => v && v.length >= 6);
const mask = (s) => { let out = String(s); for (const v of secretValues) out = out.split(v).join('***'); return out; };
const $env = new Proxy({}, { get(_, key) { if (opt.blockEnv) throw new Error('access to env vars denied'); return typeof key === 'string' ? env[key] : undefined; } });

// ── Static safety audit of workflow.json ───────────────────────────────────
const checks = [];
const check = (name, pass, detail = '') => checks.push({ name, pass: Boolean(pass), detail });
check('workflow.json is inactive on import', workflow.active === false);
check('workflow timezone is UTC', workflow.settings && workflow.settings.timezone === 'UTC');
const sched = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.scheduleTrigger');
check('weekly cron is Sunday 02:00', sched && sched.parameters.rule.interval[0].expression === '0 2 * * 0');
check('manual test trigger present', workflow.nodes.some((n) => n.type === 'n8n-nodes-base.manualTrigger'));
for (const n of workflow.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
  const hdrs = (n.parameters.headerParameters && n.parameters.headerParameters.parameters) || [];
  const auth = hdrs.find((h) => h.name.toLowerCase() === 'authorization');
  const authOk = !auth || /\{\{\s*\$env\.[A-Z_]+\s*\}\}/.test(auth.value);
  const urlOk = /^=https:\/\/api\.hubapi\.com/.test(n.parameters.url) || /^=\{\{\s*\$env\.[A-Z_]+\s*\}\}$/.test(n.parameters.url);
  check(`HTTP "${n.name}" uses $env auth/URL, no stored credentials`, authOk && urlOk && !n.credentials);
}
const secretPatterns = [/pat-(na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}/i, /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/, /xox[abpr]-[A-Za-z0-9-]{10,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/];
check('no hardcoded secrets in workflow.json', !secretPatterns.some((p) => p.test(wfText)));
const hosts = [...new Set((wfText.match(/https?:\/\/[a-z0-9.-]+/gi) || []).map((u) => u.replace(/^https?:\/\//i, '').toLowerCase()))]
  .filter((h) => !/(^|\.)example\.com$/.test(h) && !['api.hubapi.com', 'app.hubspot.com'].includes(h));
check('only example.com + official HubSpot hosts referenced', hosts.length === 0, hosts.join(', '));
const embedded = nodesByName.get('Load Sandbox Fixture').parameters.jsCode.match(/\/\* FIXTURE:START \*\/\s*const FIXTURE = ([\s\S]*?);\s*\/\* FIXTURE:END \*\//);
check('embedded sandbox fixture matches sample-payloads file', embedded && JSON.stringify(JSON.parse(embedded[1])) === JSON.stringify(JSON.parse(fs.readFileSync(DEFAULT_FIXTURE, 'utf8'))));

// ── Graph executor ─────────────────────────────────────────────────────────
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const outputs = new Map();
const executed = [];
const httpCalls = [];

const nodeAccessor = (name) => {
  if (!outputs.has(name)) throw new Error(`Referenced node "${name}" is unexecuted`);
  const items = outputs.get(name).flat();
  return { all: () => items, first: () => items[0], last: () => items[items.length - 1], get item() { throw new Error('$("node").item is not supported by the simulator; use .all()[i]'); } };
};
const evalWith = (template, scope) => {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const body = template.slice(1);
  const run = (expr) => new Function('$json', '$', '$env', '$response', `return (${expr});`)(scope.json, nodeAccessor, $env, scope.response);
  const whole = body.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => String(run(expr)));
};
const normalizeReturn = (ret, name) => {
  if (!Array.isArray(ret)) throw new Error(`Code node "${name}" must return an array of items`);
  return ret.map((it) => {
    if (!it || typeof it !== 'object' || !('json' in it)) throw new Error(`Code node "${name}" returned an item without "json"`);
    return { json: JSON.parse(JSON.stringify(it.json)) };
  });
};
const runCode = async (node, input) => {
  let src = node.parameters.jsCode;
  if (node.name === 'Load Sandbox Fixture' && !usingDefaultFixture) src = src.replace(/\/\* FIXTURE:START \*\/[\s\S]*?\/\* FIXTURE:END \*\//, `const FIXTURE = ${JSON.stringify(fixture)};`);
  const $input = { all: () => input, first: () => input[0], last: () => input[input.length - 1] };
  const fn = new AsyncFunction('$input', '$env', '$', '$execution', '$workflow', 'console', src);
  const quiet = { log() {}, warn() {}, error() {}, info() {} };
  return normalizeReturn(await fn($input, $env, nodeAccessor, { id: 'sim-0001', mode: 'manual' }, { id: 'sim', name: workflow.name }, quiet), node.name);
};
const runIf = (node, input) => {
  const t = []; const f = [];
  for (const item of input) {
    const pass = node.parameters.conditions.conditions.every((c) => {
      const v = evalWith(c.leftValue, { json: item.json });
      if (typeof v !== 'boolean') throw new Error(`IF "${node.name}" strict type validation: expected boolean, got ${typeof v}`);
      return v;
    });
    (pass ? t : f).push(item);
  }
  return [t, f];
};

// ── In-memory HubSpot (only with --mock-live). No sockets are ever opened. ──
const G = fixture.graph;
const levelByType = Object.fromEntries(Object.entries(G.levels).map(([k, v]) => [v.objectType, k]));
const mockHubSpot = (node, method, url, body) => {
  if (!opt.mockLive) throw new Error(`HTTP node "${node.name}" was reached in an offline run without --mock-live. Safe defaults should keep every HTTP node idle.`);
  const u = new URL(url);
  let m;
  if (u.hostname === 'api.hubapi.com') {
    if (method === 'GET' && (m = u.pathname.match(/^\/crm\/v3\/schemas\/([^/]+)$/))) {
      const lvl = levelByType[m[1]];
      return lvl ? G.schemas[lvl] : { error: { message: `Mock 404: unknown object type ${m[1]}`, httpCode: '404' } };
    }
    if (method === 'POST' && (m = u.pathname.match(/^\/crm\/v3\/objects\/([^/]+)\/search$/))) {
      const all = G.records[levelByType[m[1]]] || [];
      const start = body.after ? parseInt(body.after, 10) : 0;
      const page = all.slice(start, start + opt.pageSize).map((r) => ({ ...r, properties: Object.fromEntries(Object.entries(r.properties).filter(([k]) => body.properties.includes(k) || k === 'hs_object_id')) }));
      const next = start + opt.pageSize < all.length ? { next: { after: String(start + opt.pageSize) } } : undefined;
      return { total: all.length, results: page, ...(next ? { paging: next } : {}) };
    }
    if (method === 'POST' && (m = u.pathname.match(/^\/crm\/v4\/associations\/([^/]+)\/([^/]+)\/batch\/read$/))) {
      const dir = `${levelByType[m[1]]}_to_${levelByType[m[2]]}`;
      const rows = (G.associations[dir] && G.associations[dir].results) || [];
      const want = new Set(body.inputs.map((x) => String(x.id)));
      const results = rows.filter((r) => want.has(String(r.from.id)));
      const missing = [...want].filter((id) => !results.some((r) => String(r.from.id) === id));
      return { status: 'COMPLETE', results, numErrors: missing.length, errors: missing.length ? [{ status: 'error', category: 'OBJECT_NOT_FOUND', subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND', message: 'No associations found', context: { fromObjectId: missing } }] : [] };
    }
    if (method === 'POST' && /\/batch\/(create|archive|update)$/.test(u.pathname)) {
      if (opt.failWrites) return { error: { message: 'Mock 429: secondly rate limit reached', httpCode: '429' } };
      if (u.pathname.endsWith('/archive')) return {};
      return { status: 'COMPLETE', results: body.inputs.map((x, k) => ({ id: x.id || `mock-${k}`, ...x })) };
    }
  }
  if (u.hostname.endsWith('example.com')) return { data: 'ok' };
  throw new Error(`No mock for ${method} ${mask(url)}`);
};

const runHttp = async (node, input) => {
  const p = node.parameters;
  const items = node.executeOnce ? input.slice(0, 1) : input;
  const out = [];
  for (const item of items) {
    const scope = { json: item.json };
    const url = evalWith(p.url, scope);
    const headers = Object.fromEntries(((p.headerParameters && p.headerParameters.parameters) || []).map((h) => [h.name, evalWith(h.value, scope)]));
    if (!/^https:\/\//.test(String(url))) throw new Error(`HTTP "${node.name}" resolved a non-https URL: ${mask(url)}`);
    if (headers.Authorization && /undefined|null/.test(headers.Authorization)) throw new Error(`HTTP "${node.name}" Authorization header did not resolve`);
    let body = p.sendBody ? JSON.parse(evalWith(p.jsonBody, scope)) : undefined;
    const pag = p.options && p.options.pagination && p.options.pagination.pagination;
    const maxPages = pag ? Number(evalWith(pag.maxRequests, scope)) : 1;
    for (let page = 0; page < maxPages; page++) {
      httpCalls.push({ node: node.name, method: p.method, url: mask(url), bodyBytes: body ? Buffer.byteLength(JSON.stringify(body)) : 0, page: pag ? page + 1 : undefined });
      const response = mockHubSpot(node, p.method, url, body || {});
      out.push({ json: response });
      if (!pag || response.error) break;
      const done = evalWith(pag.completeExpression, { json: item.json, response: { body: response } });
      if (done === true) break;
      const param = pag.parameters.parameters[0];
      body = { ...body, [param.name]: evalWith(param.value, { json: item.json, response: { body: response } }) };
    }
  }
  return out;
};

const execute = async (startName) => {
  const queue = [{ name: startName, input: [{ json: {} }] }];
  let guard = 0;
  while (queue.length) {
    if (++guard > 300) throw new Error('Execution guard tripped (possible cycle).');
    const { name, input } = queue.shift();
    const node = nodesByName.get(name);
    if (!node) throw new Error(`Connection points to unknown node "${name}"`);
    let outs;
    if (node.type === 'n8n-nodes-base.manualTrigger' || node.type === 'n8n-nodes-base.scheduleTrigger') outs = [input];
    else if (node.type === 'n8n-nodes-base.code') outs = [await runCode(node, input)];
    else if (node.type === 'n8n-nodes-base.if') outs = runIf(node, input);
    else if (node.type === 'n8n-nodes-base.httpRequest') outs = [await runHttp(node, input)];
    else throw new Error(`Simulator does not support node type ${node.type}`);
    outputs.set(name, outs);
    executed.push({ name, itemsIn: input.length, itemsOut: outs.map((o) => o.length) });
    const conn = workflow.connections[name];
    if (!conn) continue;
    conn.main.forEach((targets, outIdx) => {
      const items = outs[outIdx] || [];
      if (!items.length) return;
      for (const t of targets || []) queue.push({ name: t.node, input: items });
    });
  }
};

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  const started = Date.now();
  let runError = null;
  try { await execute('Manual Test Trigger'); } catch (e) { runError = e; }
  const get = (n) => (outputs.has(n) ? outputs.get(n).flat()[0].json : null);
  const cfg = get('Config & Safety Gate');
  const engine = get('Association Integrity & Orphan Detection Engine');
  const preview = get('Dry-Run Remediation Preview');
  const writes = get('Collect Remediation Results');
  const slack = get('RevOps Slack Block Kit Builder');
  const summary = get('Execution Summary & Audit');

  log(bold('\nHubSpot Multi-Level Association Validator · offline simulation'));
  log(dim(`workflow: workflow.json · fixture: ${path.relative(ROOT, fixturePath)} · ${opt.mockLive ? 'MOCK-LIVE (no network)' : 'sandbox defaults'}${opt.blockEnv ? ' · $env BLOCKED' : ''}`));
  if (cfg) {
    log(bold('\nSafety gates'));
    log(`  mode=${cfg.modeLabel}  sandbox=${cfg.sandboxMode}  dryRun=${cfg.dryRun}  mutationsEnabled=${cfg.hubspotMutationsEnabled}  actions=[${cfg.enabledActions.join(', ')}]`);
    log(`  allowHubspotMutations=${cfg.allowHubspotMutations}  allowSlackSend=${cfg.allowSlackSend}  allowOpsAlert=${cfg.allowOpsAlert}`);
    (cfg.warnings || []).forEach((w) => log(dim(`  ! ${w}`)));
  }
  if (engine) {
    const s = engine.stats;
    log(bold('\nIntegrity'));
    log(`  records P/C/A = ${s.records.parent}/${s.records.child}/${s.records.asset} · healthy ${s.healthy.total}/${s.records.total} (${engine.integrityScore}%) · orphan rate ${engine.orphanRatePct}% · severity ${engine.runSeverity}`);
    log(bold('\nIssues'));
    for (const i of engine.issues) log(`  [${i.severity.padEnd(8)}] ${i.code.padEnd(30)} ${String(i.recordName).padEnd(20)} ${dim(`${i.remediation ? `${i.remediation.action} · ${i.remediation.status}` : ''}`)}`);
    log(bold('\nRemediation plan'));
    for (const gr of engine.remediationPlan.groups) log(`  ${gr.action.padEnd(30)} ${String(gr.count).padStart(3)} · ${gr.status} ${dim(gr.labels.slice(0, 4).join(' | '))}`);
    if (engine.mutationGuard.blocked) log(bad(`  guard: ${engine.mutationGuard.reasons.join('; ')}`));
  }
  if (preview) log(bold('\nHubSpot (preview only)'), `\n  blocked: ${preview.blockedReason} · would change ${preview.wouldChangeCount}`, ...preview.wouldRun.map((w) => `\n  ${w.method} ${w.endpoint} (${w.records})`));
  if (writes) log(bold('\nHubSpot (mock live)'), `\n  ${writes.succeeded}/${writes.attempted} change(s) succeeded · failures ${writes.failures.length}`);
  if (slack) log(bold('\nSlack Block Kit'), `\n  ${slack.blockCount} blocks · send=${slack.allowSend}${slack.skipReason ? ` (skipped: ${slack.skipReason})` : ''}\n  ${dim(slack.payload.text)}`);
  log(bold('\nHTTP calls'), httpCalls.length ? `(${httpCalls.length})` : '\n  none (zero external requests)');
  httpCalls.forEach((h) => log(dim(`  ${h.method} ${h.url}${h.page ? ` · page ${h.page}` : ''} · mocked`)));
  if (summary) log(bold('\nSummary'), `\n  status=${summary.status} · checksum=${summary.checksum} · opsAlert=${summary.needsOpsAlert}`);

  // ── Behavioural checks
  check('workflow executed without throwing', !runError, runError ? runError.message : '');
  if (cfg && opt.checks) {
    const outText = JSON.stringify([...outputs.values()]);
    check('no secret values leaked into any node output', secretValues.every((v) => !outText.includes(v)));
    const isDefaultRun = !opt.mockLive && !opt.envFile && opt.set.length === 0;
    if (isDefaultRun) {
      check('safe defaults: sandbox on, dry-run on', cfg.sandboxMode && cfg.dryRun);
      check('safe defaults: mutations, Slack and ops gates closed', !cfg.allowHubspotMutations && !cfg.allowSlackSend && !cfg.allowOpsAlert);
      check('safe defaults: only flag_records enabled', cfg.enabledActions.join() === 'flag_records');
      check('safe defaults: zero HTTP requests', httpCalls.length === 0);
    }
    const guardScenario = opt.set.some((s) => /^(MAX_MUTATIONS_PER_RUN|MUTATION_ABORT_ORPHAN_RATE_PCT|SEARCH_MAX_PAGES)=/.test(s));
    const truncatedScenario = engine && Object.values(engine.fetchMeta.truncated || {}).some(Boolean);
    if (truncatedScenario) {
      check('truncated: dangling links marked unverified, none archived', engine.issues.filter((i) => i.code === 'dangling_association').every((i) => i.remediation.status === 'unverified' || !engine.fetchMeta.truncated[i.relatedLevel]));
      check('truncated: mutation guard blocks all writes', engine.mutationGuard.blocked && engine.mutationGuard.reasons.some((r) => r.startsWith('search_truncated')));
    }
    if (usingDefaultFixture && engine && !truncatedScenario) {
      const ids = (code) => engine.issues.filter((i) => i.code === code).map((i) => i.recordName).sort();
      check('orphan children: C, D, G, H', ids('orphan_child').join() === 'ChildProject C,ChildProject D,ChildProject G,ChildProject H');
      check('orphan assets: W, Z', ids('orphan_asset').join() === 'AssetUnit W,AssetUnit Z');
      check('3 dangling associations to deleted IDs', ids('dangling_association').length === 3 && engine.issues.filter((i) => i.code === 'dangling_association').every((i) => ['9100999', '9200998', '9200999'].includes(i.relatedId)));
      check('cardinality violation: E', ids('cardinality_violation').join() === 'ChildProject E');
      check('label mismatch: F', ids('association_label_mismatch').join() === 'ChildProject F');
      check('broken chain: V', ids('broken_chain').join() === 'AssetUnit V');
      check('asymmetric link: U', ids('asymmetric_association').join() === 'AssetUnit U');
      check('empty parent: EmptyShell Group', ids('empty_parent').join() === 'EmptyShell Group');
      check('hint-based repairs planned only for unique matches (C→P2, Z→A) + F label fix', engine.remediationPlan.totals.create_missing_association === 3);
      check('3 verified dangling archives planned', engine.remediationPlan.totals.archive_dangling_association === 3);
      const flagGroup = engine.remediationPlan.groups.find((gr) => gr.action === 'flag_records' && gr.fromLevel === 'asset');
      check('stale flag on AssetUnit T is cleared to ok', flagGroup && flagGroup.labels.some((l) => l.startsWith('AssetUnit T: orphaned → ok')));
      check('run severity critical (orphan rate over alert threshold)', engine.runSeverity === 'critical');
      check('schema preflight passes', engine.schemaCheck.ok);
      check('Slack payload within Block Kit limits', slack && slack.blockCount <= 50 && slack.payload.blocks.every((b) => !b.text || b.text.text.length <= 3000));
    }
    if (opt.mockLive) {
      check('mock-live: schema preflight read for 3 levels', httpCalls.filter((h) => h.node === 'HubSpot: Read Schema Definitions').length === 3);
      if (opt.pageSize < G.records.child.length && !opt.set.some((x) => x.startsWith('SEARCH_MAX_PAGES='))) check('mock-live: search pagination followed (multiple pages)', httpCalls.filter((h) => h.node === 'HubSpot: Search Child Records').length > 1);
      check('mock-live: 4 association directions read', new Set(httpCalls.filter((h) => h.node.startsWith('HubSpot: Batch Read')).map((h) => h.url)).size === 4);
      if (guardScenario) {
        check('guard: mutation guard blocked remediation', engine.mutationGuard.blocked && !httpCalls.some((h) => h.node === 'HubSpot: Execute Remediation Batch'));
        check('guard: ops alert raised', summary && summary.needsOpsAlert);
      } else if (opt.failWrites) {
        check('fail-writes: completes with errors (no throw)', summary && summary.status === 'completed_with_errors');
        check('fail-writes: ops alert raised', summary && summary.needsOpsAlert && httpCalls.some((h) => h.node === 'Ops: Post Failure Alert'));
      } else {
        const order = httpCalls.filter((h) => h.node === 'HubSpot: Execute Remediation Batch').map((h) => h.url.match(/batch\/(\w+)$/)[1]);
        check('mock-live: remediation order create → archive → update', order.length > 0 && order.join(',') === [...order].sort((a, b) => ['create', 'archive', 'update'].indexOf(a) - ['create', 'archive', 'update'].indexOf(b)).join(','));
        check('mock-live: all remediation succeeded', writes && writes.failed === 0 && writes.succeeded === writes.attempted && writes.attempted > 0);
        check('mock-live: Slack alert sent', summary && summary.slack.status === 'sent');
      }
      check('mock-live: secrets masked in request log', httpCalls.every((h) => !secretValues.some((v) => h.url.includes(v))));
    }
    if (opt.blockEnv) check('blocked $env falls back to sandbox + dry-run', cfg.sandboxMode && cfg.dryRun && !cfg.envAccessible);
  }

  log(bold('\nChecks'));
  for (const c of checks) log(`  ${c.pass ? ok('PASS') : bad('FAIL')} ${c.name}${c.detail ? dim(` — ${c.detail}`) : ''}`);
  const failed = checks.filter((c) => !c.pass);
  const report = { simulatedAt: new Date().toISOString(), durationMs: Date.now() - started, options: { mockLive: opt.mockLive, failWrites: opt.failWrites, blockEnv: opt.blockEnv, fixture: path.relative(ROOT, fixturePath) }, executed, httpCalls, checks, audit: summary, engine, slackPayload: slack && slack.payload, remediationPreview: preview, remediationResults: writes };
  fs.mkdirSync(path.dirname(opt.out), { recursive: true });
  fs.writeFileSync(opt.out, mask(JSON.stringify(report, null, 2)));
  if (opt.json) console.log(mask(JSON.stringify(summary, null, 2)));
  log(dim(`\nFull report: ${path.relative(process.cwd(), opt.out)}`));
  log(failed.length ? bad(`\n${failed.length} check(s) failed.`) : ok(`\nAll ${checks.length} checks passed.`));
  if (runError && !opt.quiet) console.error(bad(runError.stack));
  process.exit(failed.length ? 1 : 0);
})();
