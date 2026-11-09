// 自动化编排：知识库匹配索引 + 任务台账（campaign）
//
// 设计取舍：
// · 匹配索引从 knowledge/*/ 的 frontmatter 现建（ports/product/keywords/cve/severity），
//   纯本地、零网络；每次查询重读目录，使新增语料立即可用。
// · 台账存 $DSH_HOME/vuln-report/campaigns.json，字段刻意保持"人能读、AI 能写"。
// · 原生工具（tools）是可选增强：@deepseek-ai/dsh-tools 拿不到就整体跳过，
//   全部能力仍可经 HTTP 使用（这条路径已在 0.10.x 验过）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { domainToASCII } from 'node:url';

const STAGES = ['recon', 'fingerprint', 'match', 'verify', 'exploit', 'lateral', 'report'];
const MAX_CAMPAIGNS = 100;
const FRONTMATTER = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const messageOf = (error) => String(error?.message || error).slice(0, 1600);
const clamp = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

function normalizeHost(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('资产 host 无效。');
  const raw = value.trim().replace(/\.$/, '');
  if (net.isIP(raw)) return raw.toLowerCase();
  const host = domainToASCII(raw).toLowerCase();
  if (!host || host.length > 253 || !host.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('资产 host 必须是域名或 IP 地址。');
  }
  return host;
}

function normalizeScopeEntry(value, allowDomain) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('授权范围包含空条目。');
  const raw = value.trim();
  if (raw.includes('/')) {
    const parts = raw.split('/');
    const family = net.isIP(parts[0]);
    const prefix = Number(parts[1]);
    if (parts.length !== 2 || !family || !/^\d+$/.test(parts[1]) || prefix > (family === 4 ? 32 : 128)) {
      throw new Error('无效 CIDR：' + clamp(raw, 80));
    }
    return parts[0].toLowerCase() + '/' + prefix;
  }
  if (!allowDomain) throw new Error('CIDR 范围必须写成 IP/前缀长度。');
  if (raw.startsWith('*.')) return '*.' + normalizeHost(raw.slice(2));
  return normalizeHost(raw);
}

function normalizeScope(raw, previous = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('必须提供授权范围。');
  const result = {};
  for (const key of ['domains', 'cidrs', 'exclude']) {
    const values = raw[key] === undefined ? previous[key] || [] : raw[key];
    if (!Array.isArray(values) || values.length > 50) throw new Error('授权范围 ' + key + ' 必须是最多 50 项的数组。');
    result[key] = values.map((value) => normalizeScopeEntry(value, key !== 'cidrs'));
  }
  // The UI has one scope input; accept CIDRs entered there without broadening domain matching.
  result.cidrs.push(...result.domains.filter((entry) => entry.includes('/')));
  result.domains = result.domains.filter((entry) => !entry.includes('/'));
  result.domains = [...new Set(result.domains)];
  result.cidrs = [...new Set(result.cidrs)];
  result.exclude = [...new Set(result.exclude)];
  if (!result.domains.length && !result.cidrs.length) throw new Error('授权范围至少需要一个域名、IP 或 CIDR。');
  return result;
}

function scopeEntryMatches(host, entry) {
  if (entry.includes('/')) {
    if (!net.isIP(host)) return false;
    const [address, prefix] = entry.split('/');
    const family = net.isIP(address);
    if (net.isIP(host) !== family) return false;
    const block = new net.BlockList();
    block.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    return block.check(host, family === 4 ? 'ipv4' : 'ipv6');
  }
  if (net.isIP(entry)) {
    if (!net.isIP(host)) return false;
    const block = new net.BlockList();
    const family = net.isIP(entry);
    block.addAddress(entry, family === 4 ? 'ipv4' : 'ipv6');
    return block.check(host, family === 4 ? 'ipv4' : 'ipv6');
  }
  if (net.isIP(host)) return false;
  const domain = entry.startsWith('*.') ? entry.slice(2) : entry;
  return host.endsWith('.' + domain) || (!entry.startsWith('*.') && host === domain);
}

function assertInScope(host, scope) {
  const allowed = [...scope.domains, ...scope.cidrs].some((entry) => scopeEntryMatches(host, entry));
  const excluded = scope.exclude.some((entry) => scopeEntryMatches(host, entry));
  if (!allowed || excluded) throw new Error('资产不在任务授权范围内：' + host);
}

function parseFrontmatter(markdown) {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    fields[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

const STOPWORDS = new Set(['gateway','server','service','client','web','http','https','httpd','api','admin','login','default','remote','manager','console','portal','access','open','source','code','test','main','index','config','system','vpn','ssl','tls','ipsec','cloud','security','edge','app','gate','proxy','auth']);
const escapeRe = (w) => w.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
/** 整词匹配：active 不能命中 activemq */
const hasWord = (hay, word) => new RegExp('(?:^|[^a-z0-9])' + escapeRe(String(word).toLowerCase()) + '(?:$|[^a-z0-9])').test(hay);
const tokens = (value) => String(value || '')
  .toLowerCase()
  .split(/[^a-z0-9.+_/-]+/)
  .filter((t) => t.length >= 2);

/** 从语料建索引：一条记录 = 一个漏洞条目。 */
export function createKbIndex(corpusDir) {
  const walkAll = (dir, out = []) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walkAll(full, out);
      else if (item.name.toLowerCase().endsWith('.md')) out.push(full);
    }
    return out;
  };
  function build() {
    const entries = [];
    let categories = [];
    try { categories = fs.readdirSync(corpusDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { categories = []; }
    for (const category of categories) {
      const dir = path.join(corpusDir, category);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'skill.md'); }
      catch { continue; }
      for (const file of files) {
        let text = '';
        try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch { continue; }
        const f = parseFrontmatter(text);
        entries.push({
          file, category, path: path.join(dir, file),
          title: f.title || file,
          cve: f.cve || '',
          severity: f.severity || 'medium',
          product: f.product || '',
          versions: f.versions || '',
          entry: f.entry || '',
          ports: String(f.ports || '').split(/[,\s]+/).filter((p) => /^\d+$/.test(p)).map(Number),
          keywordList: tokens(f.keywords),
          rawKeywords: String(f.keywords || '').split(/[,，、\s]+/).map((x) => x.trim()).filter((x) => x.length >= 2),
          text: tokens([f.title, f.product, f.cve, f.keywords, f.entry, f.versions].join(' ')),
        });
      }
    }
    return entries;
  }

  const list = () => build();

  /**
   * 指纹 → 候选条目。打分：端口 40、产品/标题命中 30、CVE 命中 20、关键词 各 10（上限 20）、critical +5。
   * 只做本地排序，不联网、不执行任何东西。
   */
  function match(input = {}, limit = 5) {
    const ports = []
      .concat(Array.isArray(input.ports) ? input.ports : [])
      .concat(input.port === undefined ? [] : [input.port])
      .map((p) => Number(p))
      .filter((p) => Number.isFinite(p));
    const haystackTokens = new Set([
      ...tokens(input.banner),
      ...tokens(input.product),
      ...tokens(Object.values(input.headers || {}).join(' ')),
      ...tokens(input.text),
    ]);
    const haystackText = [input.banner, input.product, input.text, ...Object.values(input.headers || {})]
      .filter(Boolean).join(' ').toLowerCase();

    const scored = [];
    for (const item of list()) {
      let score = 0;
      const why = [];
      if (ports.length && item.ports.some((p) => ports.includes(p))) {
        score += 35;
        why.push('端口 ' + item.ports.filter((p) => ports.includes(p)).join(','));
      }
      const productTokens = tokens(item.product);
      const productHit = productTokens.some((t) => t.length >= 3 && !STOPWORDS.has(t) && hasWord(haystackText, t));
      if (productHit) { score += 60; why.push('产品 ' + item.product); }
      if (item.cve && item.cve !== '无' && hasWord(haystackText, item.cve)) {
        score += 20; why.push('CVE ' + item.cve);
      }
      const kwHits = item.keywordList.filter((k) => k.length >= 3 && !STOPWORDS.has(k) && hasWord(haystackText, k));
      if (kwHits.length) {
        score += Math.min(16, kwHits.length * 8);
        why.push('关键词 ' + kwHits.slice(0, 4).join('/'));
      }
      const cnHits = (item.rawKeywords || []).filter((k) => /[\u4e00-\u9fa5]/.test(k) && haystackText.includes(k.toLowerCase()));
      if (cnHits.length) {
        // 长词更具体：2 字 8 分，每多一字 +2，上限 40
        const cnScore = cnHits.reduce((sum, k) => sum + 8 + Math.max(0, (k.length - 2) * 2), 0);
        score += Math.min(40, cnScore);
        why.push('中文关键词 ' + cnHits.slice(0, 3).join('/'));
      }
      const titleHits = item.text.filter((t) => t.length >= 4 && !STOPWORDS.has(t) && haystackTokens.has(t));
      if (!productHit && titleHits.length) {
        score += Math.min(18, titleHits.length * 6);
        why.push('命中 ' + titleHits.slice(0, 3).join('/'));
      }
      if (!score) continue;
      if (item.severity === 'critical') score += 5;
      scored.push({ score, why, item });
    }
    scored.sort((a, b) => b.score - a.score || a.item.file.localeCompare(b.item.file));
    return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 5))).map((hit) => ({
      file: hit.item.file,
      category: hit.item.category,
      title: hit.item.title,
      cve: hit.item.cve,
      severity: hit.item.severity,
      product: hit.item.product,
      versions: hit.item.versions,
      entry: hit.item.entry,
      ports: hit.item.ports,
      score: hit.score,
      why: hit.why,
    }));
  }

  const size = () => list().length;
  const reset = () => {};
  return { match, size, reset, list };
}

/** 技能索引：直接扫盘（AboutSecurity 249 条 + 知识库分类），不依赖会话目录注入。 */
export function createSkillIndex({ home, knowledgeDir, knowledgeEnabled = () => true, aboutSecurityEnabled = () => true } = {}) {
  const base = path.resolve(home || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
  const aboutRoot = path.join(base, 'fujiang-skills', 'aboutsecurity', 'skills');
  const fields = (file) => {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const head = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      const out = {};
      if (head) {
        for (const line of head[1].split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        }
      }
      return out;
    } catch { return {}; }
  };

  const walk = (dir, out = []) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, out);
      else if (item.name.toLowerCase() === 'skill.md') out.push(full);
    }
    return out;
  };

  const walkAll = (dir, out = []) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walkAll(full, out);
      else if (item.name.toLowerCase().endsWith('.md')) out.push(full);
    }
    return out;
  };
  function build() {
    const entries = [];
    for (const file of walk(aboutRoot)) {
      const meta = fields(file);
      const rel = path.relative(aboutRoot, path.dirname(file)).split(path.sep).join('/');
      entries.push({ name: meta.name || rel.split('/').pop(), description: meta.description || '', category: rel.split('/')[0] || 'aboutsecurity', source: 'aboutsecurity', path: file });
    }
    if (knowledgeDir) {
      // 分类索引（SKILL.md）+ 每条漏洞条目都进索引，AI 才能直接搜到具体 PoC
      for (const file of walkAll(knowledgeDir)) {
        const base = path.basename(file);
        const meta = fields(file);
        const category = path.basename(path.dirname(file));
        if (base.toLowerCase() === 'skill.md') {
          entries.push({ name: 'kb-' + (meta.name || category).replace(/^kb-/, ''), description: meta.description || '', category, source: 'knowledge', path: file });
          continue;
        }
        const name = base.replace(/\.md$/i, '');
        const summary = [meta.title || '', meta.keywords || '', meta.entry || ''].filter(Boolean).join(' · ');
        entries.push({ name, description: summary.slice(0, 240), category, source: 'knowledge-entry', path: file });
      }
    }
    return entries;
  }

  const list = () => {
    const entries = build();
    let knowledgeOn = false;
    let aboutSecurityOn = false;
    try { knowledgeOn = knowledgeEnabled() === true; } catch { /* Fail closed for bundled knowledge access. */ }
    try { aboutSecurityOn = aboutSecurityEnabled() === true; } catch { /* Fail closed for downloaded skill access. */ }
    return entries.filter((item) => item.source === 'knowledge' || item.source === 'knowledge-entry' ? knowledgeOn
      : item.source === 'aboutsecurity' ? aboutSecurityOn : true);
  };

  function search(query, limit = 8) {
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];
    const words = q.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((w) => w.length >= 2);
    const scored = [];
    for (const item of list()) {
      const hay = (item.name + ' ' + item.category + ' ' + item.description).toLowerCase();
      let score = 0;
      if (item.name.toLowerCase() === q) score += 60;
      if (item.name.toLowerCase().includes(q)) score += 40;
      if (item.category.toLowerCase().includes(q)) score += 20;
      for (const w of words) if (hay.includes(w)) score += 10;
      if (!score) continue;
      scored.push({ score, item });
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.slice(0, Math.max(1, Math.min(20, Number(limit) || 8))).map((x) => ({ name: x.item.name, category: x.item.category, source: x.item.source, description: x.item.description.slice(0, 200), path: x.item.path, score: x.score }));
  }

  function read(nameOrPath, maxBytes = 12000) {
    const key = String(nameOrPath || '').trim();
    if (!key) throw new Error('需要技能名或路径。');
    const resolvedKey = path.resolve(key);
    const entries = list();
    const hit = entries.find((x) => x.name === key)
      || entries.find((x) => x.name.toLowerCase() === key.toLowerCase())
      || entries.find((x) => path.resolve(x.path) === resolvedKey);
    if (!hit) throw new Error('没有这个技能：' + key + '（先用 skill_search 搜一下）');
    const text = fs.readFileSync(hit.path, 'utf8');
    return { name: hit.name, source: hit.source, path: hit.path, content: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }

  return { search, read, size: () => list().length, reset: () => {} };
}
/** 任务台账：$DSH_HOME/vuln-report/campaigns.json */
export function createCampaignStore(ctx, options = {}) {
  const home = path.resolve(options.home || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
  const dir = path.join(home, 'vuln-report');
  const file = path.join(dir, 'campaigns.json');

  let state = { schema: 1, updatedAt: 0, items: [] };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        schema: 1,
        updatedAt: Number(parsed?.updatedAt) || 0,
        items: Array.isArray(parsed?.items) ? parsed.items.slice(0, MAX_CAMPAIGNS) : [],
      };
    } catch { /* 空台账 */ }
    return state;
  }

  function save() {
    fs.mkdirSync(dir, { recursive: true });
    state.updatedAt = Date.now();
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
    return state;
  }

  const idOf = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  function create(raw = {}) {
    if (state.items.length >= MAX_CAMPAIGNS) throw new Error('任务数量已达上限（' + MAX_CAMPAIGNS + '）。');
    const campaign = {
      id: idOf(),
      name: clamp(String(raw.name || '未命名任务'), 120),
      stage: STAGES.includes(raw.stage) ? raw.stage : 'recon',
      scope: normalizeScope(raw.scope),
      assets: [],
      steps: [],
      attempts: [],
      note: clamp(String(raw.note || ''), 2000),
      objective: clamp(String(raw.objective || raw.name || ''), 300),
      done: raw.done === true,
      doneNote: '',
      autopilot: raw.autopilot !== false,
      rounds: 0,
      maxRounds: Number.isFinite(Number(raw.maxRounds)) ? Math.max(1, Math.min(30, Number(raw.maxRounds))) : 8,
      lastProgress: -1,
      sessionId: raw.sessionId ? clamp(String(raw.sessionId), 120) : null,
      createdBy: 'ui',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.items = [campaign, ...state.items];
    save();
    return campaign;
  }

  function get(id) {
    const campaign = state.items.find((c) => c.id === id);
    if (!campaign) throw new Error('没有这个任务：' + clamp(String(id), 64));
    return campaign;
  }

  function patch(id, body = {}) {
    const campaign = get(id);
    const name = body.name !== undefined ? clamp(String(body.name), 120) : campaign.name;
    let stage = campaign.stage;
    if (body.stage !== undefined) {
      if (!STAGES.includes(body.stage)) throw new Error('阶段必须是：' + STAGES.join(' / '));
      stage = body.stage;
    }
    const note = body.note !== undefined ? clamp(String(body.note), 2000) : campaign.note;
    let scope = campaign.scope;
    if (body.scope !== undefined) {
      const nextScope = normalizeScope(body.scope, campaign.scope);
      for (const asset of campaign.assets) assertInScope(normalizeHost(asset.host), nextScope);
      scope = nextScope;
    }
    const objective = body.objective !== undefined ? clamp(String(body.objective), 300) : campaign.objective;
    const autopilot = body.autopilot !== undefined ? body.autopilot !== false : campaign.autopilot;
    const rounds = Number.isFinite(Number(body.rounds)) ? Math.max(0, Number(body.rounds)) : campaign.rounds;
    const lastProgress = Number.isFinite(Number(body.lastProgress)) ? Number(body.lastProgress) : campaign.lastProgress;
    const done = body.done !== undefined ? body.done === true : campaign.done;
    Object.assign(campaign, { name, stage, note, scope, objective, autopilot, rounds, lastProgress, done });
    campaign.updatedAt = new Date().toISOString();
    save();
    return campaign;
  }

  function validateAsset(id, raw = {}) {
    const campaign = get(id);
    const host = normalizeHost(raw.host);
    assertInScope(host, campaign.scope);
    return host;
  }

  function upsertAsset(id, raw = {}) {
    const campaign = get(id);
    const host = validateAsset(id, raw);
    const port = Number.isFinite(Number(raw.port)) ? Number(raw.port) : null;
    const existing = campaign.assets.find((a) => a.host === host && a.port === port);
    const asset = existing || { host, port, fingerprint: '', status: 'new', kbHits: [], note: '', firstSeenAt: new Date().toISOString() };
    if (raw.fingerprint !== undefined) asset.fingerprint = clamp(String(raw.fingerprint), 300);
    if (raw.status !== undefined) asset.status = clamp(String(raw.status), 40);
    if (raw.note !== undefined) asset.note = clamp(String(raw.note), 500);
    if (Array.isArray(raw.kbHits)) asset.kbHits = raw.kbHits.map((k) => clamp(String(k), 120)).slice(0, 20);
    asset.lastSeenAt = new Date().toISOString();
    if (!existing) campaign.assets.push(asset);
    campaign.updatedAt = asset.lastSeenAt;
    save();
    return asset;
  }

  function addStep(id, raw = {}) {
    const campaign = get(id);
    const step = {
      id: 's' + (campaign.steps.length + 1) + '-' + Math.random().toString(36).slice(2, 5),
      stage: STAGES.includes(raw.stage) ? raw.stage : campaign.stage,
      action: clamp(String(raw.cmd || raw.command || (raw.action && raw.action !== 'step' ? raw.action : '')), 500),
      result: clamp(String(raw.result || ''), 4000),
      at: new Date().toISOString(),
    };
    campaign.steps.push(step);
    if (campaign.steps.length > 200) campaign.steps = campaign.steps.slice(-200);
    campaign.updatedAt = step.at;
    save();
    return step;
  }

  function addAttempt(id, raw = {}) {
    const campaign = get(id);
    const attempt = {
      id: 'a' + (campaign.attempts.length + 1),
      asset: clamp(String(raw.asset || ''), 220),
      kb: clamp(String(raw.kb || ''), 120),
      payload: clamp(String(raw.payload || ''), 800),
      outcome: clamp(String(raw.outcome || ''), 120),
      at: new Date().toISOString(),
    };
    campaign.attempts.push(attempt);
    if (campaign.attempts.length > 300) campaign.attempts = campaign.attempts.slice(-300);
    campaign.updatedAt = attempt.at;
    save();
    return attempt;
  }

  /** 绑定到某个会话（一个会话只跑一个任务）。 */
  function bind(id, sessionId) {
    const campaign = get(id);
    const session = clamp(String(sessionId || ''), 120);
    if (!session) throw new Error('bind 需要 sessionId。');
    for (const other of state.items) if (other.id !== id && other.sessionId === session) other.sessionId = null;
    campaign.sessionId = session;
    campaign.updatedAt = new Date().toISOString();
    save();
    return campaign;
  }

  /** 标记目标达成（人工或模型确认后调用）。 */
  function markDone(id, note) {
    const campaign = get(id);
    campaign.done = true;
    campaign.doneNote = clamp(String(note || ''), 500);
    campaign.updatedAt = new Date().toISOString();
    save();
    return campaign;
  }

  /** 推进一格阶段（到 report 后停住），返回 from/to。 */
  function advance(id) {
    const campaign = get(id);
    const from = campaign.stage;
    const index = STAGES.indexOf(from);
    const to = index < 0 || index >= STAGES.length - 1 ? campaign.stage : STAGES[index + 1];
    campaign.stage = to;
    campaign.updatedAt = new Date().toISOString();
    save();
    return { campaign, from, to, changed: from !== to };
  }
  function unbind(id) {
    const campaign = get(id);
    campaign.sessionId = null;
    campaign.updatedAt = new Date().toISOString();
    save();
    return campaign;
  }

  /** 会话 → 任务（一个会话最多一个）。 */
  const forSession = (sessionId) => state.items.find((c) => c.sessionId && c.sessionId === sessionId) || null;
  function remove(id) {
    const before = state.items.length;
    state.items = state.items.filter((c) => c.id !== id);
    if (state.items.length === before) throw new Error('没有这个任务：' + clamp(String(id), 64));
    save();
    return true;
  }

  /** 目标进度：阶段 0-60%，资产/尝试/命中 0-40%。粗粒度，只用来给模型目标感。 */
  function progressOf(campaign) {
    const stageIndex = Math.max(0, STAGES.indexOf(campaign.stage));
    const stagePart = (stageIndex / (STAGES.length - 1)) * 60;
    const assetsPart = Math.min(10, campaign.assets.length * 4);
    const attemptsPart = Math.min(10, campaign.attempts.length * 3);
    const hitPart = Math.min(20, campaign.attempts.filter((a) => /hit|success|ok|命中/i.test(String(a.outcome || ''))).length * 10);
    return Math.round(Math.min(100, stagePart + assetsPart + attemptsPart + hitPart));
  }

  /** 从 objective 推导"完成判据"，没有显式 doneCriteria 时用。 */
  function criteriaOf(campaign) {
    if (Array.isArray(campaign.doneCriteria) && campaign.doneCriteria.length) return campaign.doneCriteria;
    const o = String(campaign.objective || campaign.name || '');
    const out = ['有一条 verified 的 finding 作为目标达成的证据'];
    if (/后台|管理员|admin|管理端/i.test(o)) out.push('能用管理员会话访问后台接口（返回后台数据而非 401/403）');
    if (/数据|会员|拖库|导出/i.test(o)) out.push('能读取到非本人账号的业务数据（脱敏取样即可）');
    if (/shell|rce|命令执行|服务器/i.test(o)) out.push('能在目标上执行一条命令并取回输出');
    return out;
  }

  /** 下一步建议：给出阶段、待处理资产、可匹配条目（需要 kbIndex 时由调用方传入）。 */
  function nextStep(id, kbIndex) {
    const campaign = get(id);
    const index = STAGES.indexOf(campaign.stage);
    const pending = campaign.assets.filter((a) => a.status === 'new' || a.status === 'fingerprinted');
    const suggestions = [];
    if (!campaign.assets.length) suggestions.push({ kind: 'recon', text: '台账里还没有资产：先对 scope 做存活与端口探测，把 host/port 写进 assets。' });
    if (pending.length && kbIndex) {
      for (const asset of pending.slice(0, 5)) {
        const hits = kbIndex.match({ port: asset.port, text: asset.fingerprint }, 3);
        if (hits.length) suggestions.push({ kind: 'match', asset: asset.host + (asset.port ? ':' + asset.port : ''), text: '按指纹可选：' + hits.map((h) => h.cve + ' ' + h.title).join(' / '), hits: hits.map((h) => h.file) });
      }
    }
    const nextStage = index < 0 || index >= STAGES.length - 1 ? campaign.stage : STAGES[index + 1];
    const progress = progressOf(campaign);
    const stalled = progress <= campaign.lastProgress && (campaign.rounds || 0) >= 2 && !campaign.done;
    const tried = new Set(campaign.attempts.map((a) => String(a.kb || '') + '|'));
    const nextActions = [];
    for (const sug of suggestions) {
      for (const hit of (sug.hits || [])) {
        if (tried.has(hit + '|')) continue;
        nextActions.push({ action: 'verify', kb: hit, asset: sug.asset, text: '按 ' + hit + ' 的 PoC 做最小验证（只读优先）' });
      }
    }
    if (!nextActions.length && pending.length) nextActions.push({ action: 'fingerprint', text: '对 pending 资产补指纹（banner/响应头/JS 路径），再 kb_match' });
    if (stalled) nextActions.unshift({ action: 'pivot', text: '连续两轮无进展：换入口（子域/源站/后台/API 文档）或换候选条目，别重复同一 payload' });
    return {
      campaignId: campaign.id,
      objective: campaign.objective || campaign.name,
      done: campaign.done === true,
      doneCriteria: criteriaOf(campaign),
      progress,
      stalled,
      rounds: campaign.rounds || 0,
      maxRounds: campaign.maxRounds || 8,
      stage: campaign.stage,
      nextStage,
      assets: campaign.assets.length,
      pending: pending.length,
      steps: campaign.steps.length,
      attempts: campaign.attempts.length,
      instructions: STAGE_STEPS[campaign.stage] || [],
      nextActions: nextActions.slice(0, 3),
      suggestions,
    };
  }

    const STAGE_STEPS = {
      recon: ['枚举存活与端口（nmap/fscan/httpx）', '把 host/port/指纹写入 asset', 'campaign_upsert(advance=true) 进入指纹阶段'],
      fingerprint: ['识别服务与版本（banner/响应头/页面特征）', 'kb_match(port,banner) 取候选条目', 'campaign_upsert(advance=true) 进入匹配阶段'],
      match: ['从 kb_match 结果里挑一条 critical/high', 'skill 加载对应 kb-* 分类读 PoC', 'campaign_upsert(advance=true) 进入验证阶段'],
      verify: ['按条目判据做最小验证（只读、低频）', '命中→finding_upsert；未命中→换候选', 'campaign_upsert(command,result,advance=true)'],
      exploit: ['按 PoC 执行利用并保存证据', '命中→finding_upsert(severity,evidence)', 'campaign_upsert(advance=true)'],
      lateral: ['用已获凭据横向（限于 scope 内）', '每台资产更新 status', 'campaign_upsert(advance=true)'],
      report: ['导出 findings.md', '核对每条证据与复现步骤', '收尾：不再推进阶段']
    };
  const snapshot = () => ({ ok: true, updatedAt: state.updatedAt, items: state.items, stages: STAGES, path: file });
  const list = () => ({ ok: true, updatedAt: state.updatedAt, stages: STAGES, items: state.items.map((c) => ({ id: c.id, name: c.name, stage: c.stage, sessionId: c.sessionId || null, assets: c.assets.length, steps: c.steps.length, updatedAt: c.updatedAt })) });

  load();
  return { snapshot, list, create, get, patch, validateAsset, upsertAsset, addStep, addAttempt, remove, nextStep, bind, unbind, advance, markDone, progressOf, criteriaOf, forSession, reload: () => { load(); return snapshot(); }, get path() { return file; } };
}

/**
 * 可选：把能力注册成原生工具。拿不到 @deepseek-ai/dsh-tools 就返回 { ok:false, reason }，
 * 调用方据此保持 HTTP-only，不抛错、不影响插件启动。
 */
export async function registerAutomationTools(ctx, { kbIndex, campaigns, findings, skillIndex }) {
  let toolsModule = null;
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
    toolsModule = loader && typeof loader.import === 'function'
      ? await loader.import('@deepseek-ai/dsh-tools')
      : await import('@deepseek-ai/dsh-tools');
  } catch (error) {
    return { ok: false, reason: 'dsh-tools 不可用：' + messageOf(error) };
  }
  const defineTool = toolsModule?.defineTool;
  if (typeof defineTool !== 'function') return { ok: false, reason: 'dsh-tools 未导出 defineTool' };

  const registered = [];
  const schema = (properties) => ({ type: 'object', additionalProperties: false, properties });
  const text = (value) => ({ type: 'string', required: true, description: value });

  try {
    const fiber = ctx.inject(['tools'], (scope) => {
      if (!scope?.tools || typeof scope.tools.register !== 'function') return;
      const defs = [
        {
          name: 'kb_match',
          description: '按端口/指纹在本地 CVE/PoC 知识库里匹配候选条目（不联网）。返回 file/cve/severity/entry 与命中理由。',
          parameters: { port: { type: 'number', description: '端口号' }, banner: text('服务指纹或 banner'), product: { type: 'string', description: '产品名' } },
          output: { schema: schema({ hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } }), render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
          execute: async (args) => ({ hits: kbIndex.match({ port: args.port, banner: args.banner, product: args.product }, 5) }),
        },
        {
          name: 'campaign_upsert',
          description: '在用户已创建的任务里记账：写入资产、推进阶段。不新建任务。',
          parameters: { campaignId: text('任务 id（必须由用户先创建）'), stage: { type: 'string', description: 'recon|fingerprint|match|verify|exploit|lateral|report' }, host: { type: 'string', description: '资产 host' }, port: { type: 'number', description: '资产端口' }, fingerprint: { type: 'string', description: '指纹' }, command: { type: 'string', description: '本步执行的命令（写入步骤）' }, sessionId: { type: 'string', description: '把任务绑定到该会话（通常由用户指定）' }, result: { type: 'string', description: '本步结论（写入步骤）' }, status: { type: 'string', description: '资产状态：new|fingerprinted|verified|exploited|blocked' }, advance: { type: 'boolean', description: '置 true 时把阶段推进一格（recon→…→report）' }, done: { type: 'boolean', description: '置 true 表示目标已达成（停止自动续跑）' }, autopilot: { type: 'boolean', description: '置 false 关闭自动续跑' }, objective: { type: 'string', description: '任务目标（一句话，用于完成判据）' } },
          output: { schema: schema({ campaign: { type: 'object', required: true, additionalProperties: true }, stage: { type: 'object', additionalProperties: true } }), render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
          execute: async (args) => {
            if (!args.campaignId) throw new Error('任务只能由用户在插件面板里创建；请在已有的 campaignId 下记账。');
            if (args.stage && !STAGES.includes(args.stage)) throw new Error('阶段必须是：' + STAGES.join(' / '));
            let campaign = campaigns.get(args.campaignId);
            if (args.host) campaigns.validateAsset(campaign.id, { host: args.host });
            if (args.host) campaigns.upsertAsset(campaign.id, { host: args.host, port: args.port, fingerprint: args.fingerprint, status: args.status });
            if (args.stage) campaign = campaigns.patch(campaign.id, { stage: args.stage });
            if (args.objective !== undefined) campaign = campaigns.patch(campaign.id, { objective: args.objective });
            if (args.done === true) campaign = campaigns.markDone(campaign.id, args.result || '');
            if (args.command || args.result) campaigns.addStep(campaign.id, { stage: args.stage || campaign.stage, cmd: args.command, result: args.result });
            if (args.sessionId) campaign = campaigns.bind(campaign.id, args.sessionId);
            let moved = null;
            if (args.advance === true) { const res = campaigns.advance(campaign.id); campaign = res.campaign; moved = { from: res.from, to: res.to, changed: res.changed }; }
            return moved ? { campaign: campaigns.get(campaign.id), stage: moved } : { campaign: campaigns.get(campaign.id) };
          },
        },
        {
          name: 'finding_upsert',
          description: '把一个确认的漏洞写进漏洞报告（等价 POST /findings）。',
          parameters: { title: text('漏洞标题'), severity: text('critical|high|medium|low|info'), target: { type: 'string', description: '目标' }, evidence: { type: 'string', description: '证据' }, remediation: { type: 'string', description: '修复建议' }, verified: { type: 'boolean', description: '是否已验证' } },
          output: { schema: schema({ item: { type: 'object', required: true, additionalProperties: true } }), render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
          execute: async (args) => ({ item: findings.upsert({ title: args.title, severity: args.severity, target: args.target, evidence: args.evidence, remediation: args.remediation, verified: args.verified, source: 'ai' }) }),
        },
        {
          name: 'skill_search',
          description: '按关键词搜索本地技能库（AboutSecurity 方法论 + 知识库分类），不依赖会话目录。返回 name/category/source/path。',
          parameters: { query: text('关键词，例如 sqli / ad / privilege / 反序列化'), limit: { type: 'number', description: '返回条数（默认 8）' } },
          output: { schema: schema({ hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } } }), render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
          execute: async (args) => ({ hits: skillIndex.search(args.query, args.limit) }),
        },
        {
          name: 'skill_read',
          description: '读取一个技能的 SKILL.md 正文（先用 skill_search 找到名字或 path）。',
          parameters: { name: text('技能名或绝对路径'), maxBytes: { type: 'number', description: '最多返回多少字符（默认 12000）' } },
          output: { schema: schema({ name: { type: 'string', required: true }, path: { type: 'string', required: true }, content: { type: 'string', required: true }, source: { type: 'string' }, truncated: { type: 'boolean' } }), render: (args, value) => [{ type: 'text', text: String(value.content || '').slice(0, 4000) }] },
          execute: async (args) => skillIndex.read(args.name, args.maxBytes),
        },        {
          name: 'pipeline_next',
          description: '返回任务建议的下一阶段与待处理资产、可选漏洞条目。',
          parameters: { campaignId: text('任务 id') },
          output: { schema: schema({ next: { type: 'object', required: true, additionalProperties: true } }), render: (args, value) => [{ type: 'text', text: JSON.stringify(value).slice(0, 4000) }] },
          execute: async (args) => ({ next: campaigns.nextStep(args.campaignId, kbIndex) }),
        },
      ];
      for (const def of defs) {
        try { scope.tools.register(defineTool(def)); registered.push(def.name); }
        catch (error) { ctx.logger?.warn?.('[dsh-prompt-custom] 工具注册失败 ' + def.name + '：' + messageOf(error)); }
      }
    });
    await fiber;
  } catch (error) {
    return { ok: false, reason: 'tools 服务不可用：' + messageOf(error), registered };
  }
  return { ok: registered.length > 0, registered };
}
