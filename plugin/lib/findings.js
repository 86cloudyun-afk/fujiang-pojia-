// 漏洞报告存储：$DSH_HOME/vuln-report/findings.json
//
// 为什么用 HTTP 而不是 ctx.tools.register()：工具注册要求 @deepseek-ai/dsh-tools 的
// defineTool 与 peer 依赖，装不上就是整页报错；而宿主已经有一套回环 HTTP 路由，
// AI 用自己的 shell（curl/pwsh）一条命令就能把发现写进来，零新依赖、零协议风险。
//
// 写入方（AI）拿到的是：POST /api/dsh-prompt-custom/findings
//   { "action": "upsert", "title": "...", "severity": "critical", "target": "...", ... }
// 页签只读这份文件，不参与取证，所以这里**不做**任何网络访问。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const STATUSES = ['open', 'fixed', 'accepted', 'false-positive'];
const MAX_ITEMS = 500;
const TEXT_LIMIT = 8000;

const messageOf = (error) => String(error?.message || error).slice(0, 1600);
const clampText = (value) => (typeof value === 'string' ? value.slice(0, TEXT_LIMIT) : '');
const oneLine = (value, limit = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function atomicWrite(file, text) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

export function createFindingsStore(ctx, options = {}) {
  const home = path.resolve(options.home || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
  const root = path.join(home, 'vuln-report');
  const file = path.join(root, 'findings.json');

  let state = { schema: 1, updatedAt: 0, items: [] };
  let lastError = null;

  const normalizeItem = (raw, previous) => {
    const target = oneLine(raw?.target ?? previous?.target ?? '', 300);
    const evidence = clampText(raw?.evidence ?? previous?.evidence ?? '');
    const item = {
      id: oneLine(raw?.id || previous?.id || '', 64) || 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: oneLine(raw?.title || previous?.title || '未命名漏洞', 200),
      severity: SEVERITIES.includes(raw?.severity) ? raw.severity : (previous?.severity || 'medium'),
      status: STATUSES.includes(raw?.status) ? raw.status : (previous?.status || 'open'),
      target,
      url: oneLine(raw?.url ?? previous?.url ?? '', 500),
      category: oneLine(raw?.category ?? previous?.category ?? '', 120),
      cve: oneLine(raw?.cve ?? previous?.cve ?? '', 120),
      source: oneLine(raw?.source ?? previous?.source ?? 'ai', 40),
      cvss: Number.isFinite(Number(raw?.cvss ?? previous?.cvss)) ? Math.max(0, Math.min(10, Number(raw?.cvss ?? previous?.cvss))) : null,
      evidence,
      description: clampText(raw?.description ?? previous?.description ?? ''),
      remediation: clampText(raw?.remediation ?? previous?.remediation ?? ''),
      references: clampText(raw?.references ?? previous?.references ?? ''),
      verified: (raw?.verified === true || previous?.verified === true)
        && !!(target && evidence.trim()),
      foundAt: oneLine(raw?.foundAt ?? previous?.foundAt ?? '', 40) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return item;
  };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items.filter((x) => x && typeof x === 'object') : [];
      state = { schema: 1, updatedAt: Number(parsed?.updatedAt) || 0, items: items.slice(0, MAX_ITEMS) };
    } catch { /* 文件不存在或损坏：空报告 */ }
    return state;
  }

  function save() {
    fs.mkdirSync(root, { recursive: true });
    state.updatedAt = Date.now();
    atomicWrite(file, JSON.stringify(state, null, 2) + '\n');
    return state;
  }

  const stats = () => {
    const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: state.items.length, open: 0 };
    for (const item of state.items) {
      if (out[item.severity] === undefined) out[item.severity] = 0;
      out[item.severity] += 1;
      if (item.status === 'open') out.open += 1;
    }
    return out;
  };

  const snapshot = () => ({
    ok: true,
    items: state.items.slice().sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || String(b.foundAt).localeCompare(String(a.foundAt))),
    stats: stats(),
    updatedAt: state.updatedAt,
    path: file,
    error: lastError,
  });

  function upsert(raw) {
    if (!state.items.length) load();
    const previous = raw?.id ? state.items.find((x) => x.id === raw.id) : undefined;
    const item = normalizeItem(raw || {}, previous);
    if (!previous && item.source === 'ai' && (!item.target || !item.evidence.trim())) {
      throw new Error('AI 新增漏洞必须提供目标和证据。');
    }
    if (previous) state.items = state.items.map((x) => (x.id === item.id ? item : x));
    else {
      if (state.items.length >= MAX_ITEMS) throw new Error('报告条目已达上限（' + MAX_ITEMS + '），请先清理。');
      state.items = [item, ...state.items];
    }
    save();
    return item;
  }

  function remove(id) {
    if (!state.items.length) load();
    const key = oneLine(id, 64);
    const before = state.items.length;
    state.items = state.items.filter((x) => x.id !== key);
    if (state.items.length === before) throw new Error('没有这条记录：' + key);
    save();
    return true;
  }

  function clear() {
    state.items = [];
    save();
    return true;
  }

  function setStatus(id, status) {
    if (!STATUSES.includes(status)) throw new Error('不支持的状态：' + status);
    const key = oneLine(id, 64);
    if (!state.items.length) load();
    if (!state.items.some((item) => item.id === key)) throw new Error('没有这条记录：' + key);
    return upsert({ id: key, status });
  }

  /** Markdown 报告：按严重度分组，含统计表与逐条证据。 */
  function toMarkdown() {
    const s = stats();
    const label = { critical: '严重', high: '高危', medium: '中危', low: '低危', info: '信息' };
    const lines = [
      '# 漏洞报告',
      '',
      '- 生成时间：' + new Date().toISOString(),
      '- 条目总数：' + s.total + '（严重 ' + s.critical + ' / 高危 ' + s.high + ' / 中危 ' + s.medium + ' / 低危 ' + s.low + ' / 信息 ' + s.info + '）',
      '- 未修复：' + s.open,
      '',
      '## 汇总',
      '',
      '| 严重度 | 数量 |',
      '|---|---|',
      '| 严重 | ' + s.critical + ' |',
      '| 高危 | ' + s.high + ' |',
      '| 中危 | ' + s.medium + ' |',
      '| 低危 | ' + s.low + ' |',
      '| 信息 | ' + s.info + ' |',
      '',
    ];
    for (const severity of SEVERITIES) {
      const group = state.items.filter((x) => x.severity === severity);
      if (!group.length) continue;
      lines.push('## ' + label[severity] + '（' + group.length + '）', '');
      for (const item of group) {
        lines.push('### ' + item.title, '');
        if (item.target || item.url) lines.push('- 目标：' + [item.target, item.url].filter(Boolean).join(' · '));
        if (item.cve) lines.push('- CVE：' + item.cve);
        if (item.category) lines.push('- 类别：' + item.category);
        if (item.cvss !== null) lines.push('- CVSS：' + item.cvss);
        lines.push('- 状态：' + item.status + (item.verified ? '（已验证）' : '（未验证）'));
        lines.push('- 发现时间：' + item.foundAt);
        lines.push('');
        if (item.description) lines.push('**描述**', '', item.description, '');
        if (item.evidence) lines.push('**证据**', '', ...item.evidence.split(/\r?\n/).map((line) => '    ' + line), '');
        if (item.remediation) lines.push('**修复建议**', '', item.remediation, '');
        if (item.references) lines.push('**参考**', '', item.references, '');
        lines.push('---', '');
      }
    }
    return lines.join('\n');
  }

  load();

  return {
    snapshot,
    upsert,
    remove,
    clear,
    setStatus,
    toMarkdown,
    stats,
    reload: () => { lastError = null; load(); return snapshot(); },
    get path() { return file; },
  };
}
