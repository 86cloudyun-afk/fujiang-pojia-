// dsh-prompt-custom — 知识库（内置 CVE / PoC 语料）
//
// 与 skills.js（REA，按需下载）、aboutsecurity.js（按需下载）不同，本库的语料
// **随插件分发**：plugin/knowledge/ 下的 markdown 就是这个插件自己的文件。
// 因此这里没有下载、没有解压、没有 npm、没有网络 —— 唯一的磁盘动作是读写
// $DSH_HOME/fujiang-skills/knowledge-state.json 里的一个布尔开关。
//
// 为什么按「分类」注册成多个 skill 而不是一条大 skill：
//   模型看到的是每个 skill 的 name+description（<available_skills> 目录），
//   正文只在该 skill 被调用时才注入。按分类切分后，目录里每条描述都能精确
//   指路（Java 反序列化 / 边界设备 / Exchange+AD / Windows+AD / CMS / 本地
//   提权 / 云与容器），既省上下文，又让模型在一次「这是什么漏洞」里直接命中。
//
// 语料协议的单一来源是每个分类目录下的 SKILL.md 的 frontmatter：
//   ---
//   name: kb-java-deser
//   description: ...
//   ---
// 正文靠 get() 现读，所以改语料不需要重启宿主进程（下一次 list/get 就更新），
// 只有「开关」与「分类增删」需要重启。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const OWNER = 'dsh-prompt-custom:skill-library:v1';
const MARKER = '.fujiang-owner.json';
const PROVIDER = 'fujiang-knowledge';
const VERSION = '1.3.1'

/** 与 skills.js / aboutsecurity.js 同款目录主权标记（同一根目录，同一个 owner）。 */
const CATALOG = Object.freeze({
  id: 'knowledge',
  name: '知识库',
  projectName: 'CVE / PoC 漏洞知识库',
  license: '随插件分发，仅本地',
});

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS = path.join(moduleDir, '..', 'knowledge');

/** 分类目录 → skill 名；skill 名必须是小写连字符（内核的 skill 名约束）。 */
const CATEGORIES = Object.freeze([
  { dir: 'java-deser', fallback: 'kb-java-deser' },
  { dir: 'java-web', fallback: 'kb-java-web' },
  { dir: 'edge-device', fallback: 'kb-edge-device' },
  { dir: 'exchange-ad', fallback: 'kb-exchange-ad' },
  { dir: 'web-cms', fallback: 'kb-web-cms' },
  { dir: 'linux-priv', fallback: 'kb-linux-priv' },
  { dir: 'cloud-container', fallback: 'kb-cloud-container' },
  { dir: 'gray-market', fallback: 'kb-gray-market' },
  { dir: 'triage', fallback: 'kb-triage' },
]);

const messageOf = (error) => String(error?.message || error).slice(0, 1600);
const isInside = (base, file) => {
  const relative = path.relative(base, file);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function writeJson(file, value) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, file);
}

/** frontmatter 只认 `---` 包起来的平坦 key: value；值不做 YAML 语义展开。 */
const FRONTMATTER = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function unquote(value) {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length > 1) return text.slice(1, -1);
  return text;
}

function parseFrontmatter(markdown) {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { fields: {}, body: markdown };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const split = line.indexOf(':');
    if (split <= 0) continue;
    const key = line.slice(0, split).trim();
    if (!/^[a-z][a-z0-9-]*$/.test(key)) continue;
    fields[key] = unquote(line.slice(split + 1));
  }
  return { fields, body: markdown.slice(match[0].length) };
}

export function createKnowledgeLibrary(ctx, options = {}) {
  const home = path.resolve(options.home || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
  const root = path.join(home, 'fujiang-skills');
  const stateFile = path.join(root, 'knowledge-state.json');
  const corpus = path.resolve(options.corpus || DEFAULT_CORPUS);

  // 默认开启：语料是插件自带的本地文件，不联网、不下载，开箱即可被模型读到。
  let state = { enabled: true };
  let active = false;
  let phase = 'disabled';
  let error = null;
  let busy = false;
  let closed = false;
  let providerDispose = null;
  let runtimeCtx = null;
  let restored = false;
  let cache = null;

  function assertOwned(dir) {
    if (!isInside(home, dir)) throw new Error('技能目录不在插件管理范围内。');
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('技能目录是链接，已停止操作以保护其他安装。');
    if (readJson(path.join(dir, MARKER)).owner !== OWNER) throw new Error('目录不属于本插件，已停止操作。');
  }
  function ensureRoot() {
    fs.mkdirSync(home, { recursive: true });
    if (fs.existsSync(root)) assertOwned(root);
    else {
      fs.mkdirSync(root);
      writeJson(path.join(root, MARKER), { owner: OWNER });
    }
  }
  function save() { ensureRoot(); writeJson(stateFile, { schema: 1, enabled: state.enabled === true }); }

  /** 读一个分类：SKILL.md 的 frontmatter 决定 skill 名与描述，正文原样成为 content。 */
  function readCategory(spec) {
    const dir = path.join(corpus, spec.dir);
    if (!isInside(corpus, dir)) throw new Error('分类目录越界：' + spec.dir);
    const file = path.join(dir, 'SKILL.md');
    const markdown = fs.readFileSync(file, 'utf8');
    const { fields, body } = parseFrontmatter(markdown);
    const name = fields.name || spec.fallback;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('知识库 skill 名不合规：' + name);
    const entries = fs.readdirSync(dir)
      .filter((item) => item.endsWith('.md') && item.toLowerCase() !== 'skill.md')
      .sort();
    return {
      dir, file, name,
      description: String(fields.description || name).replace(/\s+/g, ' ').trim().slice(0, 1200),
      body,
      entries,
    };
  }

  function categories() {
    if (cache) return cache;
    const list = [];
    for (const spec of CATEGORIES) {
      try { list.push(readCategory(spec)); }
      catch (cause) {
        if (fs.existsSync(path.join(corpus, spec.dir))) error = messageOf(cause);
      }
    }
    cache = list;
    return cache;
  }

  const entryCount = () => categories().reduce((total, item) => total + item.entries.length, 0);

  /** 给设置页用的分类目录：分类标题 + 逐条 title/severity/entry（只读自 frontmatter）。 */
  const catalog = () => categories().map((item) => {
    let title = item.name;
    try {
      const match = /^#\s+(.+)$/m.exec(fs.readFileSync(item.file, 'utf8'));
      if (match) title = match[1].trim();
    } catch { /* 读不到就用 skill 名 */ }
    const entries = item.entries.map((file) => {
      try {
        const { fields } = parseFrontmatter(fs.readFileSync(path.join(item.dir, file), 'utf8'));
        return { file, title: fields.title || file, severity: fields.severity || '-', entry: fields.entry || '' };
      } catch { return { file, title: file, severity: '-', entry: '' }; }
    });
    return { name: item.name, title, count: entries.length, entries };
  });

  const snapshot = () => {
    let skillCount = 0;
    let entries = 0;
    try { skillCount = categories().length; entries = entryCount(); }
    catch (cause) { error = messageOf(cause); }
    return {
      ok: true,
      skills: [{
        ...CATALOG,
        installed: true,
        enabled: active,
        busy,
        phase,
        version: VERSION,
        skillCount,
        registered: active,
        entries,
        tools: 0,
        canCancel: false,
        progress: null,
        message: error || (skillCount ? null : '知识库语料缺失，请重新安装插件。'),
      }],
    };
  };

  function deactivate() {
    active = false;
    if (providerDispose) { const dispose = providerDispose; providerDispose = null; dispose(); }
    phase = state.enabled ? 'disabled' : 'disabled';
  }

  /** 注册一个只读 provider：list() 给目录，get() 现读正文。语料改了立刻可见。 */
  function activate() {
    if (active) return;
    if (closed) throw new Error('插件已停止，请重启 DSH。');
    if (!runtimeCtx) throw new Error('当前 DSH 尚未提供技能服务，请完整重启官方 Desktop 后重试。');
    cache = null;                       // 开关一次 = 重新读一遍分类与描述
    const list = categories();
    if (!list.length) throw new Error('知识库语料缺失，请重新安装插件。');
    providerDispose = runtimeCtx.skills.registerProvider(() => ({
      name: PROVIDER,
      async list() {
        return list.map((item) => ({
          name: item.name,
          description: item.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: PROVIDER,
          path: item.file,
          resourceBase: { kind: 'directory', path: item.dir },
          rank: 700,
          locator: item,
          metadata: { knowledge: true, entries: item.entries.length, version: VERSION },
        }));
      },
      async get(candidate) {
        const item = candidate?.locator || list.find((entry) => entry.name === candidate?.name);
        if (!item) throw new Error('知识库条目已失效，请重新开关一次知识库。');
        const markdown = fs.readFileSync(item.file, 'utf8');
        const { body } = parseFrontmatter(markdown);
        // 条目清单**每次现读**：往目录里加一条 md 不需要重开关，下一次调用就能看见。
        let entries = item.entries;
        try {
          entries = fs.readdirSync(item.dir)
            .filter((file) => file.endsWith('.md') && file.toLowerCase() !== 'skill.md')
            .sort();
        } catch { /* 目录消失时退回注册时的清单 */ }
        const index = entries.map((file) => '- `' + file + '`').join('\n');
        const content = [body.trim(), '', '---', '',
          '语料目录：`' + item.dir + '`',
          '',
          '逐条详情（指纹 / 前置条件 / PoC / 利用步骤 / 修复）都在同目录，直接用 read 工具读取：',
          '',
          index || '（本分类暂无条目）',
        ].join('\n');
        return {
          name: item.name,
          description: item.description,
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'custom',
          provider: PROVIDER,
          path: item.file,
          resourceBase: { kind: 'directory', path: item.dir },
          content,
        };
      },
    }));
    active = true;
    phase = 'ready';
    error = null;
  }

  function start(action, task) {
    if (closed) return { status: 503, body: { ...snapshot(), ok: false, message: '插件已停止，请重启。' } };
    if (busy) return { status: 409, body: { ...snapshot(), ok: false, message: '正在处理，请等待当前操作完成。' } };
    busy = true; error = null;
    phase = { enable: 'enabling', disable: 'disabling' }[action] || phase;
    Promise.resolve().then(task).catch((cause) => {
      error = messageOf(cause);
      phase = 'error';
      try { ctx.logger?.warn?.('知识库：' + error); } catch { /* optional logger */ }
    }).finally(() => {
      busy = false;
      if (phase !== 'error') phase = active ? 'ready' : 'disabled';
    });
    return { status: 202, body: snapshot() };
  }

  function action(body) {
    if (!body || Array.isArray(body) || body.id !== CATALOG.id
      || !['enable', 'disable'].includes(body.action)
      || Object.keys(body).some((key) => !['id', 'action'].includes(key))) {
      return { status: 400, body: { ok: false, message: '不支持的知识库操作。' } };
    }
    return start(body.action, async () => {
      if (body.action === 'enable') {
        state.enabled = true; save(); activate();
      } else {
        state.enabled = false; save(); deactivate();
      }
    });
  }

  ctx.inject(['skills'], (scope) => {
    runtimeCtx = scope;
    scope.effect(() => async () => { runtimeCtx = null; deactivate(); }, 'fujiang-knowledge: runtime cleanup');
    if (restored && state.enabled && !active && !busy && !closed) start('enable', async () => { activate(); });
  });

  const restore = async () => {
    try {
      if (fs.existsSync(stateFile)) {
        const saved = readJson(stateFile);
        state = { enabled: saved?.enabled !== false };
      }
      if (!categories().length) { error = '知识库语料缺失，请重新安装插件。'; phase = 'error'; return; }
      phase = 'disabled';
      if (state.enabled && runtimeCtx) start('enable', async () => { activate(); });
    } catch (cause) {
      error = messageOf(cause);
      phase = 'error';
    } finally {
      restored = true;
    }
  };
  const ready = new Promise((resolve) => setImmediate(() => resolve(restore())));

  ctx.effect(() => async () => {
    closed = true;
    deactivate();
  }, 'fujiang-knowledge: manager cleanup');

  const listForTest = async () => categories();
  return { listForTest, snapshot, action, catalog, ready, settled: async () => { await ready; }, resetCache: () => { cache = null; } };
}
