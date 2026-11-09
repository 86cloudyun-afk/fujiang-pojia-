// dsh-prompt-custom（独立移植版）— host 半边
//
// ── 0.3.0 修复：注入作用域（此前「静默不生效」的根因） ──────────────────────
// 内核 SystemPrompt 的节注册表是**分层**的（@deepseek-ai/dsh-scope 的 ScopedLayers）：
// 一个全局层 + 每个 agent 一个 scoped 层。装配时 merge() 先铺全局，再让作用域链由远到近
// 用 Map.set 覆盖同名节（dsh-scope/lib/index.js:177-181）——**判重只发生在同一层内**。
//
// 所以「替换官方人设」的正确语义是：用**同名节**注册到**更近的作用域**。
//   ✗ 注册到插件自己的（根）ctx：根层已被 SystemPrompt 构造函数占用，必然抛
//       prompt section "deployment:persona-prefix" is already registered
//       (for a per-agent override, register through that agent's `agent.ctx` instead)
//     旧版把这个异常 try/catch 吞进 logger，HTTP 只回 applied:null —— 用户侧表现为
//     「开关是开的、保存显示已保存、但提示词根本没注入」。
//   ✓ 注册到 agent.ctx（该 agent 的作用域）：落在 agent 层，遮蔽全局 persona，替换生效。
//
// 本版照内核官方宿主插件范例实现（dsh-file-reference-local/lib/index.js:339-372）：
//   agent.ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section(...))
//   + ctx.get('agents').list() 补历史 agent + agent/created 增量 + agent/disposed 清理。
// 用 agent.ctx.inject(...) 而不是 agent.ctx.systemPrompt：作用域 ctx 是 createScope() 造出来的
// 无 inject 的 fiber，直接取服务拿不到；必须用 inject 派生子 fiber（官方同款写法）。
//
// 另外：节的 text 传**函数**（内核每步装配都重新求值，dsh-system-prompt/lib/index.js:342），
// 因此改文本无需重注册，下一步就生效；只有「启用开关」或「append↔replace 模式」变化才需要
// 重注册（两种模式的节名不同：dsh:custom-prompt vs deployment:persona-prefix）。
//
// ── 0.3.0 附带修复：把静默失败变成可见 ────────────────────────────────────
// /config 现在回传 armed / injected / lastError；设置页据此显示真实状态，
// 不再无条件显示「已保存」。注入失败时把内核错误原文一路带到 UI。
//
// ── 0.4.0 新增：提示词卡（多份提示词留存 + 一键切换） ──────────────────────
// 配置文件新增 `cards` 字段：数组，每张 { id, name, text }。刻意**与 enabled/mode/text
// 同文件**：读（GET 回读）、写（非破坏性合并）、陌生键告警、proto 错配保护全部复用同一条
// 通道，不引入第二处落盘。卡片文本只有被「使用」后才成为 live.text —— 在那之前不参与
// 注入、也不参与变量扫描（激活瞬间它就是 live.text，告警自然覆盖）。
//
// 协议号 2→3 的原因：新界面 + 旧宿主（只刷新页面没重启进程）时，旧宿主的 normalize
// 会把 POST 里的 cards **静默丢掉** —— 正是本插件最忌讳的「界面说存了、数据没了」。
// proto 拉到 3 后新界面能识别这种错配，把卡片区禁用并把原因说清。
// 3→4 增加只传递启用状态的 composer toggle 路由，避免把提示词正文暴露给该控件。
//
// 另修一条既有隐患：POST 的 cards 字段**必须是数组**才认。非数组（客户端 bug / 手工
// 请求）不得把磁盘上已有的卡片清空 —— strip 掉该字段、保留现状，与「非破坏性写盘」同一条立场。
//
// 配置存 $DSH_HOME/prompt-custom.json；读写走插件自己的 webServer 路由。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSkillLibrary } from './skills.js';
import { createAboutSecuritySkillLibrary } from './aboutsecurity.js';
import { createKnowledgeLibrary } from './knowledge.js';
import { createFindingsStore } from './findings.js';
import { createKbIndex, createCampaignStore, createSkillIndex, registerAutomationTools } from './automation.js';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-prompt-custom';
export const inject = ['systemPrompt', 'webServer'];

const SECTION_CUSTOM = 'dsh:custom-prompt';
// 官方固定开场白独立于 deployment persona，必须按它自己的节名覆盖。
const SECTION_HARNESS_IDENTITY = 'harness:identity';
// 与内核同名才叫「替换」；改名只会变成并列追加（dsh-system-prompt/lib/index.js:49-57）。
const SECTION_PERSONA_PREFIX = 'deployment:persona-prefix';
const SECTION_PERSONA_SUFFIX = 'deployment:persona-suffix';
// 内核 SECTION_ORDERS 的兜底值，仅当 getSectionOrder 取不到时使用。
const ORDER_PERSONA_PREFIX = 0;
const ORDER_PERSONA_SUFFIX = 10200;
const ORDER_HARNESS_IDENTITY = -1000;
const CONFIG_ROUTE = '/api/dsh-prompt-custom/config';
const PREVIEW_ROUTE = '/api/dsh-prompt-custom/preview';
const TOGGLE_ROUTE = '/api/dsh-prompt-custom/toggle';
const KNOWLEDGE_ROUTE = '/api/dsh-prompt-custom/knowledge';
const FINDINGS_ROUTE = '/api/dsh-prompt-custom/findings';
const FINDINGS_MD_ROUTE = '/api/dsh-prompt-custom/findings.md';
const MATCH_ROUTE = '/api/dsh-prompt-custom/match';
const CAMPAIGNS_ROUTE = '/api/dsh-prompt-custom/campaigns';
// HTTP 接口协议版本。client 会核对它：宿主 Node 进程不重启就不会换插件代码，
// 而页面一刷新就会拿到新的 client bundle —— 这个错配必须能被 UI 说清楚。
// 2→3 (0.4.0): config added cards; 3→4 adds the prompt-free toggle route.
const API_PROTO = 11;
const PLUGIN_VERSION = '0.20.12';

function configPath() {
  const home = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
    ? String(process.env.DSH_HOME).trim()
    : path.join(os.homedir(), '.dsh');
  return path.join(home, 'prompt-custom.json');
}

function readFileConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    // 必须是**非数组**的普通对象。数组也满足 typeof === 'object'，若不排除，
    // 它会被当成 {"0":..,"1":..} 到处流窜：
    //   · normalize() 展开出 0/1 这种伪字段
    //   · detectUnknownConfigKeys() 会把 "0"/"1" 报成「陌生配置键」（假告警）
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/**
 * 写配置。**只覆盖本插件拥有的字段，保留磁盘上其它键**（非破坏性写盘）。
 *
 * 为什么必须这样：这个文件可能被**另一个版本**的插件写过（例如新版多了一个 `prefix` 字段）。
 * 如果旧版本直接把整个文件重写成自己那三个字段，用户在新版本里的设置就被**不可逆地抹掉**了
 * —— 这与本插件历史上那次「静默失效」是同一类事故：界面上什么都没说，数据就没了。
 * 未知键的存在会由 `unknownConfigKeys` 报到界面上，但**保存本身不能把它们删掉**。
 */
function writeFileConfig(cfg) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let base = {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) base = raw;
  } catch { /* 文件不存在或已损坏：从空对象开始 */ }
  const out = { ...base, ...cfg };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return file;
}

// 提示词卡的上限与字段规格（client 侧 CARDS_MAX 与 CARD_ID 判据必须与这里配对）。
const MAX_CARDS = 50;
const CARD_NAME_MAX = 60;
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 与 client 的 newCardId() 同形状（主机侧只做兜底：手工编辑的文件里缺 id 时补一个）。 */
function makeCardId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 净化卡片数组。注意签名与语义：**非数组一律归 []**（不是 null）——
 * 调用点要先判定「body 里到底带没带 cards 字段」，带非数组时 strip 掉整个字段
 * 让 merge 保留现状；能走到这里的非数组只可能是磁盘上本来就没有 cards（冷启动），
 * 归 [] 正是「还没有卡片」。
 *
 * 逐张净化：非对象/双空（name 与 text 都为空）丢弃；name 截断；id 缺失或不合规补发。
 * 上限 MAX_CARDS：超出截断（客户端 UI 同值封顶，正常交互走不到这里；手工编辑的极端
 * 文件由 GET 回读时截断展示，保存时落成截断后的数组 —— 在代码注释里明说，不装看不见）。
 */
function sanitizeCards(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const text = typeof raw.text === 'string' ? raw.text : '';
    let name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length > CARD_NAME_MAX) name = name.slice(0, CARD_NAME_MAX);
    if (!name && !text) continue;
    const id = typeof raw.id === 'string' && CARD_ID.test(raw.id) ? raw.id : makeCardId();
    out.push({ id, name: name || '未命名卡片', text });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}

function normalize(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    enabled: src.enabled === true,
    mode: src.mode === 'replace' ? 'replace' : 'append',
    text: typeof src.text === 'string' ? src.text : '',
    cards: sanitizeCards(src.cards)
  };
}

function isLoopback(req) {
  const ra = (req.socket && req.socket.remoteAddress) || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(data.length)
  });
  res.end(data);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// 内核的变量语法（dsh-system-prompt/lib/index.js:58-61）。
const VAR_GROUP = /^\{\{([^{}]*)\}\}/;
const VAR_NAME = /^[a-z][a-z0-9_]*$/;

/** 新建一个变量扫描结果。 */
function newSink() { return { missing: new Set(), malformed: new Set() }; }

/**
 * 只扫描不替换：找出配置文本里会被内核判为「未知/畸形变量」的引用。
 * 这不是学术洁癖 —— 内核 renderPrompt 对未知变量是**抛错**（会让整轮运行失败），
 * 所以用户写出一个 {{modell}} 会让每一次模型步都炸，而页面上什么都看不到。
 * 这里把它变成设置页上的一条可见警告。
 */
function scanVariables(text, known, sink) {
  if (typeof text !== 'string' || !text.includes('{{')) return;
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = VAR_GROUP.exec(text.slice(open));
    if (group === null) { last = open + 2; continue; }
    const name = group[0].slice(2, -2);
    if (!VAR_NAME.test(name)) sink.malformed.add(name);
    else if (!known.has(name)) sink.missing.add(name);
    last = open + group[0].length;
  }
}

/**
 * 预览用的插值：已知变量替换成实际值，未知/畸形**原样保留**（预览要宽容，
 * 与内核装配时的抛错行为相对）。扫描结果记进 sink，供页面提示。
 */
function interpolateText(text, variables, sink) {
  if (typeof text !== 'string') return '';
  if (!text.includes('{{')) return text;
  let out = '';
  let last = 0;
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = VAR_GROUP.exec(text.slice(open));
    if (group === null) { out += text.slice(last, open + 2); last = open + 2; continue; }
    const name = group[0].slice(2, -2);
    const known = VAR_NAME.test(name);
    const value = known && Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (known && value !== undefined) {
      out += text.slice(last, open) + String(value);
    } else {
      if (known) sink.missing.add(name); else sink.malformed.add(name);
      out += text.slice(last, open + group[0].length);
    }
    last = open + group[0].length;
  }
  return out + text.slice(last);
}

/** 把装配结果渲染成预览文本（含变量替换）。 */
function renderSections(assembly, sink) {
  const secs = (assembly && assembly.sections) || [];
  const vars = (assembly && assembly.variables) || {};
  return secs
    .filter(Boolean)
    .map((s) => {
      const raw = typeof s.text === 'string' ? s.text : String((s && s.text) || '');
      return s.interpolate === false ? raw : interpolateText(raw, vars, sink);
    })
    .filter((t) => t && t.trim())
    .join('\n\n');
}

/** 只取节名。`assemble()` 返回的 section 只有 `{ name, text, interpolate? }`，**没有 order**
 *  （dsh-system-prompt/lib/index.js:339-344）；order 要用 `getSectionOrder('常量名')` 取，
 *  而这里的 `s.name` 是节名（如 `"deployment:persona-prefix"`）不是常量名，取不到。
 *  所以这里**不返回** order —— 早先版本返回的 `order: undefined` 是个恒定的死字段。 */
function sectionNames(assembly) {
  return ((assembly && assembly.sections) || [])
    .filter(Boolean)
    .map((s) => ({ name: s.name }));
}

/**
 * 本版本认识的配置字段。之外的键 = 这个配置文件是**别的版本**的插件写的。
 *
 * 为什么要专门检测：配置 schema 一旦演进（比如把 `text` 拆成 `prefix`/`suffix`），
 * 新代码读不懂旧文件里的 `text` → 用户**正在生效的提示词会静默消失**。
 * 这个插件已经吃过一次「静默失效」的亏（见 index.js 顶部注释），不能在同源风险上再栽一次。
 */
const KNOWN_CONFIG_KEYS = new Set(['enabled', 'mode', 'text', 'cards']);

export function apply(ctx, config) {
  const reaSkillLibrary = createSkillLibrary(ctx);
  const aboutSecurityLibrary = createAboutSecuritySkillLibrary(ctx);
  // 知识库：语料随插件分发（plugin/knowledge/），零下载、零网络，默认开启。
  const knowledgeLibrary = createKnowledgeLibrary(ctx);
  // 漏洞报告：持久化在 DSH_HOME/vuln-report/findings.json；AI 通过回环 HTTP 写入。
  const findings = createFindingsStore(ctx);
  // 自动化编排：本地匹配索引（读 knowledge/ frontmatter）+ 任务台账。
  const corpusDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'knowledge');
  const kbIndex = createKbIndex(corpusDir);
  const knowledgeEnabled = () => knowledgeLibrary.snapshot().skills[0]?.enabled === true;
  const availableKbIndex = {
    size: () => knowledgeEnabled() ? kbIndex.size() : 0,
    match: (...args) => knowledgeEnabled() ? kbIndex.match(...args) : [],
  };
  const campaigns = createCampaignStore(ctx);
  const aboutSecurityEnabled = () => aboutSecurityLibrary.snapshot().skills[0]?.enabled === true;
  const skillIndex = createSkillIndex({ knowledgeDir: corpusDir, knowledgeEnabled, aboutSecurityEnabled });
  const skillLibrary = {
    ready: Promise.all([reaSkillLibrary.ready, aboutSecurityLibrary.ready, knowledgeLibrary.ready]),
    snapshot: () => ({ ok: true, skills: [
      ...knowledgeLibrary.snapshot().skills,
      ...reaSkillLibrary.snapshot().skills,
      ...aboutSecurityLibrary.snapshot().skills,
    ] }),
    action: body => {
      const id = body?.id;
      if (id === 'knowledge') return knowledgeLibrary.action(body);
      if (id === 'aboutsecurity') return aboutSecurityLibrary.action(body);
      return reaSkillLibrary.action(body);
    },
  };
  const log = (msg) => { try { ctx.logger?.info?.(msg); } catch { console.log(msg); } };
  const warn = (msg) => { try { ctx.logger?.warn?.(msg); } catch { console.warn(msg); } };

  let live = normalize({ ...(config || {}), ...(readFileConfig() || {}) });
  let lastError = null;                 // 最近一次注入失败的内核原文；null = 无错误
  const entries = new Map();            // agent -> { shape: 'off'|'append'|'replace', fiber }
  let lastAgent = null;                 // 供 /preview 选作用域

  /** 当前配置对应的注入形态；'off' 表示不该有任何自定义节。 */
  const desiredShape = () => {
    if (!live.enabled || !String(live.text || '').trim()) return 'off';
    return live.mode === 'replace' ? 'replace' : 'append';
  };

  /**
   * 节文本用函数：内核每次装配都重新求值（dsh-system-prompt/lib/index.js:342），
   * 所以改文本无需重注册、下一步就生效。
   *
   * 这里**不做**「形态/开关是否仍匹配」的判断：那种判断的失败形态是返回空串，
   * 而 replace 模式下空串会把官方人设整段抹掉（比多留一步旧文案严重得多）。
   * 形态与开关的一致性交给 install 的重注册保证（POST 与 GET 都会对齐）。
   *
   * textShadow 专门堵「文本被清空的转换窗口」：清空文本会让 desiredShape 变 'off'，
   * 而销毁已注册的 replace 节是在后续微任务里完成的；在两者之间内核若恰好装配一次，
   * 空串就会把官方人设抹掉（验证台 E4/E6 抓到的空人设帧）。清空时沿用上一份非空文本，
   * 节随后就被销毁、官方人设自然恢复 —— 于是这个窗口不可能产出空人设。
   * 稳态下 textShadow 完全惰性：文本为空时根本不会有节被注册，currentText 不会被调用。
   */
  let textShadow = String(live.text || '');
  const currentText = () => {
    const text = String(live.text || '');
    if (text.trim()) textShadow = text;
    return textShadow;
  };

  const orderOf = (sp, key, fallback) => {
    try {
      const v = typeof sp.getSectionOrder === 'function' ? sp.getSectionOrder(key) : undefined;
      return Number.isFinite(v) ? v : fallback;
    } catch { return fallback; }
  };

  // 安装/卸载串行化：agent/created（内核 serial 且被 await）与设置页保存可能并发，
  // 交错会留下「注册了一半」，或对同一 agent 重复注册（后者会撞内核重名保护）。
  //
  // 关键：这条队列**永不 reject**。它挂在 agent/created 的 listener 上，而内核的
  // serial 派发一旦被 listener 的 rejection 传染，就会让**会话创建失败**——插件绝不能
  // 有这个能力。失败一律降级成 lastError（再由设置页显示出来）。
  let queue = Promise.resolve();
  const serialize = (fn) => {
    const next = queue.then(fn, fn).catch((error) => {
      lastError = String((error && error.message) || error);
      warn('[dsh-prompt-custom] 安装队列异常（已降级）：' + lastError);
    });
    queue = next;
    return next;
  };

  const disposeEntry = async (agent) => {
    const entry = entries.get(agent);
    if (!entry) return;
    entries.delete(agent);
    if (lastAgent === agent) lastAgent = null;
    if (!entry.fiber) return;
    try { await entry.fiber.dispose(); } catch { /* agent 作用域通常已随之销毁 */ }
  };

  /**
   * 在一个 agent 的作用域里装上（或卸下）自定义节。
   * 调用方负责串行化（install / reinstallAll 已持锁）。
   */
  const installInner = async (agent) => {
    if (!agent || !agent.ctx || typeof agent.ctx.inject !== 'function') return;
    const shape = desiredShape();
    const entry = entries.get(agent);
    if (entry && entry.shape === shape) return;      // 形态没变：文本函数自己会跟上
    if (entry) await disposeEntry(agent);
    if (shape === 'off') { entries.set(agent, { shape: 'off', fiber: null }); return; }

    let fiber = null;
    try {
      fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        try {
          const sp = scope.systemPrompt;
          // 仅在自定义提示词生效的 agent 层移除官方固定开场白。
          // 不改用户正文；禁用插件/清空正文时随该 fiber 一起卸载，恢复官方默认。
          sp.section({
            name: SECTION_HARNESS_IDENTITY,
            order: orderOf(sp, 'HARNESS_IDENTITY', ORDER_HARNESS_IDENTITY),
            text: ''
          });
          if (shape === 'replace') {
            // 同名才叫替换；suffix 必须**显式补空节**，否则全局 suffix 仍然生效
            // （merge 只覆盖出现过的名字）。
            sp.section({
              name: SECTION_PERSONA_PREFIX,
              order: orderOf(sp, 'DEPLOYMENT_PERSONA_PREFIX', ORDER_PERSONA_PREFIX),
              text: currentText
            });
            sp.section({
              name: SECTION_PERSONA_SUFFIX,
              order: orderOf(sp, 'DEPLOYMENT_PERSONA_SUFFIX', ORDER_PERSONA_SUFFIX),
              text: ''
            });
          } else {
            sp.section({
              name: SECTION_CUSTOM,
              order: orderOf(sp, 'DEPLOYMENT_PERSONA_SUFFIX', ORDER_PERSONA_SUFFIX) + 1,
              text: currentText
            });
          }
          lastError = null;
        } catch (error) {
          lastError = String((error && error.message) || error);
          warn('[dsh-prompt-custom] 注入失败（agent ' + (agent.id || '?') + '）：' + lastError);
        }
      });
      await fiber;                                   // 等装载完，状态才准
      entries.set(agent, { shape, fiber });
      lastAgent = agent;
      log('[dsh-prompt-custom] 已注入 agent ' + (agent.id || '?') + '：mode=' + shape);
    } catch (error) {
      lastError = String((error && error.message) || error);
      warn('[dsh-prompt-custom] agent 作用域注册失败：' + lastError);
      try { await fiber?.dispose?.(); } catch { /* ignore */ }
      entries.set(agent, { shape: 'off', fiber: null });
    }
  };

  const install = (agent) => serialize(() => installInner(agent));

  /** 配置变化后，把所有已知 agent 的注入形态刷成当前配置。 */
  const reinstallAll = () => serialize(async () => {
    for (const agent of [...entries.keys()]) await installInner(agent);
  });

  /** 活会话列表（只读；不做任何注入或唤醒）。 */
  const liveAgents = () => {
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
      return agents && typeof agents.list === 'function' ? (agents.list() || []) : [];
    } catch { return []; }
  };

  // ---- 自动续跑：不达标就继续推，直到 done 或轮次上限 ----
  const autopilotTimers = new Map();

  const autopilotMessage = (campaign, next) => [
    '继续任务「' + (campaign.objective || campaign.name) + '」（' + campaign.id + '）。',
    '- 当前阶段：' + next.stage + '｜进度：' + next.progress + '%｜第 ' + next.rounds + '/' + next.maxRounds + ' 轮',
    '- 完成判据：' + next.doneCriteria.join('；'),
    next.stalled ? '- 已连续无进展：换入口/换候选，禁止重复同一 payload。' : '',
    '- 本轮必须做：' + (next.nextActions.length ? next.nextActions.map((a) => a.text).join('；') : next.instructions.join('；')),
    '- 做完立刻 finding_upsert（命中）与 campaign_upsert(advance=true)；未命中也要记 attempt 说明排除原因。',
    '- 达成判据后调用 campaign_upsert(done=true)，不要再空转。'
  ].filter(Boolean).join('\n');

  const autopilotTick = (id) => {
    let campaign;
    try { campaign = campaigns.get(id); } catch (error) { return { ticked: false, reason: String((error && error.message) || error) }; }
    if (campaign.done === true) return { ticked: false, reason: 'done' };
    if (campaign.autopilot === false) return { ticked: false, reason: 'autopilot-off' };
    if ((campaign.rounds || 0) >= (campaign.maxRounds || 8)) return { ticked: false, reason: 'max-rounds' };
    const agent = liveAgents().find((a) => a.id === campaign.sessionId);
    if (!agent) return { ticked: false, reason: 'no-agent' };
    const next = campaigns.nextStep(campaign.id, availableKbIndex);
    const moved = campaigns.patch(campaign.id, { rounds: (campaign.rounds || 0) + 1, lastProgress: next.progress });
    const msg = autopilotMessage(moved, next);
    const llm = llmModule;
    const createUserMessage = llm && llm.createUserMessage;
    const message = typeof createUserMessage === 'function'
      ? createUserMessage({ content: [{ type: 'text', text: msg }], source: { kind: 'user' } })
      : { role: 'user', content: [{ type: 'text', text: msg }], source: { kind: 'user' }, id: 'ap' + Date.now().toString(36) };
    try {
      Promise.resolve(agent.followup(message)).catch(() => {});
      return { ticked: true, round: moved.rounds, progress: next.progress };
    } catch (error) {
      return { ticked: false, reason: String((error && error.message) || error) };
    }
  };

  const scheduleAutopilot = (id, delay = 20000) => {
    if (autopilotTimers.has(id)) return;
    const timer = setTimeout(() => {
      autopilotTimers.delete(id);
      const result = autopilotTick(id);
      if (result.ticked) scheduleAutopilot(id, delay);
    }, delay);
    if (timer.unref) timer.unref();
    autopilotTimers.set(id, timer);
  };

  const stopAutopilot = (id) => {
    const timer = autopilotTimers.get(id);
    if (timer) { clearTimeout(timer); autopilotTimers.delete(id); }
  };

  // ---- 自动开跑：用内核消息工厂构造真正的 user 消息（不是裸对象）----
  let llmModule;
  const loadLlm = async () => {
    if (llmModule !== undefined) return llmModule;
    try {
      const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
      llmModule = loader && typeof loader.import === 'function'
        ? await loader.import('@deepseek-ai/dsh-llm')
        : await import('@deepseek-ai/dsh-llm');
    } catch { llmModule = null; }
    return llmModule;
  };

  const kickText = (campaign) => '开始执行任务「' + campaign.name + '」（' + campaign.id + '）。先读台账与当前阶段，给出本阶段计划，然后逐步执行；每完成一步用 campaign_upsert 记下步骤与阶段。';

  const kickAgent = async (agent, campaign) => {
    if (!agent || typeof agent.followup !== 'function') return { kicked: false, reason: '没有可用的活会话' };
    if (agent.status !== 'idle') return { kicked: false, reason: '会话正忙（' + String(agent.status) + '）' };
    const llm = await loadLlm();
    const createUserMessage = llm && llm.createUserMessage;
    const content = [{ type: 'text', text: kickText(campaign) }];
    let message;
    try {
      // 首选内核工厂；拿不到就按 createMessage 的形状手工补 role/id（缺 role 正是上次坏会话的原因）。
      message = typeof createUserMessage === 'function'
        ? createUserMessage({ content, source: { kind: 'user' } })
        : { role: 'user', content, source: { kind: 'user' }, id: 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
    } catch (error) { return { kicked: false, reason: '构造消息失败：' + String((error && error.message) || error) }; }
    if (!message || message.role !== 'user') return { kicked: false, reason: '消息缺少 role=user，已中止' };
    try { await Promise.resolve(agent.followup(message)); return { kicked: true }; }
    catch (error) { return { kicked: false, reason: 'followup 失败：' + String((error && error.message) || error) }; }
  };
  // 固定规则节：文本常量，绝不随轮次变化（避免运行期改动系统提示）。
  const RULES_SECTION = 'campaign:rules';
  const ORDER_RULES = 1101;
  const RULES_TEXT = [
    '## 渗透作业链（固定规则）',
    '',
    '1. 每个对话只属于一个任务；用户说「继续」「开始」时，先调用 pipeline_next 读取当前阶段与建议。',
    '2. 侦察/指纹阶段：拿到端口或 banner 后，必须先调用 kb_match 或 skill 加载对应知识库分类，按条目的 PoC 与判据执行；不要凭记忆编造利用步骤。',
    '3. 分类选择：Java 中间件 → kb-java-web / kb-java-deser；边界设备 → kb-edge-device；Windows/AD/Exchange → kb-exchange-ad；PHP/CMS → kb-web-cms；Linux 提权 → kb-linux-priv；云原生/中间件 → kb-cloud-container；博彩/黑灰产业务面 → kb-gray-market；流程与报告规范 → kb-triage。',
    '4. 每完成一次验证（命中或排除），立刻用 finding_upsert 写报告（未命中不要写），再用 campaign_upsert 记录 command/result 并调用 campaign_upsert(advance) 推进一格阶段。',
    '5. 阶段推进到底才结束：recon → fingerprint → match → verify → exploit → lateral → report。不要停在一个阶段等用户催。',
    '6. 任务的目标是完成 objective，不是走完流程：每轮结束前必须回答——达标了吗？没达标就继续。',
    '7. 连续两轮无进展（stalled）就换入口或换候选，禁止重复同一 payload；达成判据后调用 campaign_upsert(done=true)。',
    '8. 任务只能由用户创建；绑定与解绑由用户决定。'
  ].join('\n');
  // ---- 会话标识节：静态文本（agent 创建时注册一次），供 AI 精确绑定任务 ----
  const CAMPAIGN_SECTION = 'campaign:session-id';
  const CAMPAIGN_CONTEXT_SECTION = 'campaign:context';
  const ORDER_CAMPAIGN = 1100;
  const campaignFibers = new Map();

  const installCampaign = async (agent) => {
    if (!agent || !agent.id || !agent.ctx || typeof agent.ctx.inject !== 'function') return;
    if (campaignFibers.has(agent)) return;
    const text = '## 会话标识\n- 当前会话 id（sessionId）：' + agent.id + '\n- 用户说「绑任务 X」时，调用 campaign_upsert 并把 sessionId 传成这个 id，即可只绑本对话。';
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.section({ name: CAMPAIGN_SECTION, order: ORDER_CAMPAIGN, text });
        if (agent.__withRules) scope.systemPrompt.section({ name: RULES_SECTION, order: ORDER_RULES, text: RULES_TEXT });
        scope.systemPrompt.section({
          name: CAMPAIGN_CONTEXT_SECTION,
          order: ORDER_RULES + 1,
          text: () => {
            const campaign = campaigns.forSession(agent.id);
            if (!campaign) return '';
            const next = campaigns.nextStep(campaign.id, availableKbIndex);
            return [
          '目标：' + (campaign.objective || campaign.name),
          '进度：' + next.progress + '%' + (next.stalled ? '（连续无进展，换方向）' : ''),
          '完成判据：' + next.doneCriteria.join('；'),
              '## 当前绑定的渗透任务',
              '- 任务：' + campaign.name + ' (' + campaign.id + ')',
              '- 阶段：' + campaign.stage,
              '- 授权域名：' + campaign.scope.domains.join(', '),
              '- 授权 CIDR：' + campaign.scope.cidrs.join(', '),
              '- 排除范围：' + campaign.scope.exclude.join(', '),
              '- 已记录资产：' + campaign.assets.length,
              '- 下一步：' + next.instructions.join('；'),
              '- 只处理上述授权范围内的目标；使用 kb_match、skill_search/skill_read 查证候选，验证后用 finding_upsert 写证据，并用 campaign_upsert 记录进度。',
            ].join('\n');
          },
        });
      });
      await fiber;
      campaignFibers.set(agent, fiber);
    } catch (error) {
      warn('[dsh-prompt-custom] 会话标识节注入失败：' + ((error && error.message) || error));
    }
  };

  const disposeCampaign = (agent) => {
    const fiber = campaignFibers.get(agent);
    if (!fiber) return;
    campaignFibers.delete(agent);
    try { const pending = fiber.dispose?.(); if (pending && pending.catch) pending.catch(() => {}); } catch { /* ignore */ }
  };
  // ---- 生命周期 ----
  // 补历史 agent（宿主插件 apply 时通常为空；HMR / 后启用时才有意义）。
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const list = agents && typeof agents.list === 'function' ? agents.list() : [];
      for (const agent of list || []) {
        agent.__withRules = true;
        install(agent); installCampaign(agent);
      }
  } catch (error) {
    warn('[dsh-prompt-custom] 补历史 agent 失败（忽略）：' + ((error && error.message) || error));
  }

  // agent/created 是 serial 且被 await 的：这里装好的节一定参与该 agent 的第一次装配。
  // 注意 listener 抛错会让会话创建失败（内核语义），所以一律吞掉并记进 lastError。
  ctx.on('agent/created', async ({ agent } = {}) => {
    if (!agent) return;
    lastAgent = agent;
    if (!entries.has(agent)) entries.set(agent, { shape: 'off', fiber: null });
    agent.__withRules = true;
    await install(agent);
    await installCampaign(agent);
  });

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (!agent) return;
    disposeCampaign(agent);
    const entry = entries.get(agent);
    if (!entry) return;
    entries.delete(agent);
    if (lastAgent === agent) lastAgent = null;
    // 节本身注册在 agent 的作用域 fiber 上，会随 agent 一起销毁；这里只清记录。
    // 刻意**不 await** dispose：agent 作用域此时已在拆除，若 dispose 悬挂会卡死
    // 上面那条串行队列，让后续所有 agent 都装不上。
    try {
      const p = entry.fiber?.dispose?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
  });

  const setConfig = async (next) => {
    live = normalize({ ...live, ...next });
    try { writeFileConfig(live); }
    catch (error) { warn('[dsh-prompt-custom] 持久化失败：' + ((error && error.message) || error)); }
    await reinstallAll();
    return live;
  };

  /** 给设置页用的真实状态：armed=配置就绪、injected=当前已注入的活 agent 数、lastError=内核原文。 */
  const status = () => {
    let injected = 0;
    for (const entry of entries.values()) if (entry.shape !== 'off') injected++;
    return {
      // 接口协议版本：client 半边可能因为「只刷新页面不重启」而先于宿主更新
      // （页面会重新取 index.html，从而拿到新的 client bundle；但宿主 Node 进程里的
      //  插件代码不重启就不会换）。client 靠这个字段判定错配并给出可执行的提示，
      //  否则用户只会看到一个空预览框，完全不知道发生了什么。
      proto: API_PROTO,
      armed: desiredShape() !== 'off',
      agents: entries.size,
      injected,
      lastError,
      // 配置文件里有本版本不认识的键（schema 演进保护，见文件顶部注释）
      unknownConfigKeys: detectUnknownConfigKeys(),
      path: configPath()
    };
  };

  // 变量告警必须同时挂在 /config 上（不能只在 /preview）：
  // 未知变量会让内核 renderPrompt 抛错 → **每一轮模型步都失败**，
  // 用户一进设置页就该看到这个隐患，而不是「点过预览之后」才出现。
  // 已知变量名一律从内核真实装配的 variables 里取，绝不写死（否则会误报）。
  let knownVarNames = null;
  const refreshKnownVars = async () => {
    try {
      const assembly = await ctx.systemPrompt.assemble({});
      knownVarNames = new Set(Object.keys((assembly && assembly.variables) || {}));
    } catch { /* 保持上一次的集合，宁可不报也不要误报 */ }
    return knownVarNames;
  };
  const variableWarnings = () => {
    const sink = newSink();
    if (knownVarNames) {
      // 注意：这里扫描的是**所有承载提示词文本的字段**。将来若把 text 拆成多段，
      // 必须把新字段一并加进来，否则未知变量告警会漏掉一半（后果是每轮模型步抛错）。
      // 0.4.0 的 cards 不在此列：卡片文本在被「使用」之前不参与注入，
      // 激活瞬间它就变成 live.text，由这条扫描自然覆盖。
      for (const key of ['text']) {
        try { scanVariables(String(live[key] || ''), knownVarNames, sink); } catch { /* ignore */ }
      }
    }
    return { unknownVariables: [...sink.missing], malformedVariables: [...sink.malformed] };
  };

  /**
   * 配置文件里有本版本不认识的键 → 说明它是别的版本的插件写的。
   * 不回传就等于让「配置 schema 演进」变成又一次静默失效。
   */
  const detectUnknownConfigKeys = () => {
    try {
      const raw = readFileConfig();
      return raw ? Object.keys(raw).filter((k) => !KNOWN_CONFIG_KEYS.has(k)) : [];
    } catch { return []; }
  };

  // ---- HTTP 路由（回环限制） ----
  let automationTools = { ok: false, pending: true };
  ctx.inject(['webServer'], (webCtx) => {
    const route = (p, handler) => {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: p, handler }),
        'dsh-prompt-custom: route ' + p
      );
    };

    route('/api/dsh-prompt-custom/skills', async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      // Browsers must use the local UI; reject cross-site mutation requests.
      if (req.method === 'POST' && req.headers?.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
            sendJson(res, 403, { ok: false, message: 'forbidden origin' }); return;
          }
        } catch { sendJson(res, 403, { ok: false, message: 'invalid origin' }); return; }
      }
      await skillLibrary.ready;
      if (req.method === 'GET' || req.method === 'HEAD') { sendJson(res, 200, skillLibrary.snapshot()); return; }
      if (req.method === 'POST') {
        try {
          const result = skillLibrary.action(await readBody(req, 1024));
          sendJson(res, result.status, result.body);
        } catch (error) { sendJson(res, 400, { ok: false, message: String(error?.message || error) }); }
        return;
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' }); res.end();
    });

    route(TOGGLE_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const fromDisk = readFileConfig();
        if (fromDisk) live = normalize({ ...live, ...fromDisk });
        await reinstallAll();
        sendJson(res, 200, { ok: true, enabled: live.enabled });
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req, 1024);
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
            sendJson(res, 400, { ok: false, message: 'enabled must be a boolean' });
            return;
          }
          const fromDisk = readFileConfig();
          if (fromDisk) live = normalize({ ...live, ...fromDisk });
          const saved = await setConfig({ enabled: body.enabled });
          sendJson(res, 200, { ok: true, enabled: saved.enabled });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
    });

    // 活会话列表：给"把任务绑到哪个对话"用
    route("/api/dsh-prompt-custom/sessions", async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end("forbidden"); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
      try {
        const sessions = liveAgents().filter((agent) => agent && agent.id).map((agent) => {
          // 标题尽力而为：不同内核版本把标题放在不同位置，读不到就交给前端显示 id 尾号。
          const probes = [agent.title, agent.session && agent.session.title, agent.session && agent.session.meta && agent.session.meta.title, agent.options && agent.options.title];
          const title = probes.find((x) => typeof x === 'string' && x.trim().length > 0) || '';
          return { id: agent.id, title, status: typeof agent.status === 'string' ? agent.status : '' };
        });
        sendJson(res, 200, { ok: true, proto: API_PROTO, sessions });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
      }
    });

    // 自检：把"知识库能不能被 AI 看到"这条链路逐段摊开
    route("/api/dsh-prompt-custom/diagnostics", async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end("forbidden"); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD" }); res.end(); return; }
      const report = { ok: true, proto: API_PROTO, version: PLUGIN_VERSION };
      try {
        const catalog = knowledgeLibrary.catalog();
        const snap = knowledgeLibrary.snapshot();
        const provider = snap.skills && snap.skills[0] ? snap.skills[0] : {};
        let listed = null;
        try { listed = typeof knowledgeLibrary.listForTest === "function" ? (await knowledgeLibrary.listForTest()).length : null; } catch { listed = "error"; }
        report.knowledge = {
          corpusPath: knowledgeLibrary.corpusPath || corpusDir,
          entries: catalog.reduce((sum, item) => sum + item.count, 0),
          categories: catalog.length,
          enabled: provider.enabled === true,
          providerRegistered: provider.registered === true,
          providerEntries: listed,
          phase: provider.phase || null,
          message: provider.message || null,
        };
      } catch (error) {
        report.knowledge = { error: String((error && error.message) || error) };
      }
      try {
        report.skillsService = typeof (ctx.get && ctx.get("skills")) === "object" || typeof (ctx.get && ctx.get("skills")) === "function" ? "present" : "missing";
      } catch { report.skillsService = "unknown"; }
      // 技能库（AboutSecurity / REA）：装没装、注册了多少
      try {
        const libs = [];
        for (const lib of [reaSkillLibrary, aboutSecurityLibrary]) {
          if (!lib || typeof lib.snapshot !== "function") continue;
          const one = lib.snapshot();
          const item = one && one.skills && one.skills[0] ? one.skills[0] : null;
          if (!item) continue;
          libs.push({ id: item.id || null, installed: item.installed === true, enabled: item.enabled === true, phase: item.phase || null, skillCount: typeof item.skillCount === "number" ? item.skillCount : null, message: item.message || null });
        }
        report.skillLibraries = libs;
      } catch (error) { report.skillLibraries = [{ error: String((error && error.message) || error) }]; }
      try { report.agents = liveAgents().length; } catch { report.agents = 0; }
      try { report.campaigns = campaigns.list().items.length; } catch { report.campaigns = 0; }
      try { report.findings = findings.snapshot().items.length; } catch { report.findings = 0; }
      report.automationTools = automationTools;
      report.tail = { version: PLUGIN_VERSION, proto: API_PROTO, dsh: process.versions && process.versions.node ? "node " + process.versions.node : "node" };
      sendJson(res, 200, report);
    });

    // 免责声明点「拒绝」时调用：先回包，再关掉整个 Harness。
    route("/api/dsh-prompt-custom/shutdown", async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end("forbidden"); return; }
      if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }); res.end(); return; }
      const origin = req.headers?.origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          if (parsed.host !== req.headers.host || !["http:", "https:"].includes(parsed.protocol)) {
            sendJson(res, 403, { ok: false, message: "forbidden origin" });
            return;
          }
        } catch { sendJson(res, 403, { ok: false, message: "invalid origin" }); return; }
      }
      sendJson(res, 200, { ok: true, message: "shutting down" });
      log("[dsh-prompt-custom] 用户拒绝免责声明，正在关闭 Harness");
      setTimeout(() => { try { process.exit(0); } catch { } }, 500);
    });
    // 指纹 → 知识库候选（本地索引，不联网）
    route(MATCH_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
      try {
        const body = await readBody(req, 64 * 1024);
        sendJson(res, 200, { ok: true, proto: API_PROTO, enabled: knowledgeEnabled(), indexSize: availableKbIndex.size(), hits: availableKbIndex.match(body || {}, body && body.limit) });
      } catch (error) {
        sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
      }
    });

    // 任务台账：GET 列表 / GET ?id= 详情 / POST 动作
    route(CAMPAIGNS_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1');
          const id = url.searchParams.get('id');
          const sid = url.searchParams.get('sessionId');
          if (sid && !id) {
            const bound = campaigns.forSession(sid);
            sendJson(res, 200, { ok: true, proto: API_PROTO, sessionId: sid, campaign: bound, ...campaigns.list() });
            return;
          }
          if (id) {
            const campaign = campaigns.get(id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, campaign, next: campaigns.nextStep(id, availableKbIndex), stages: ['recon', 'fingerprint', 'match', 'verify', 'exploit', 'lateral', 'report'] });
            return;
          }
          sendJson(res, 200, { proto: API_PROTO, ...campaigns.list() });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
        }
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req, 256 * 1024);
          const action = String((body && body.action) || 'create');
          // 任务只能由用户在面板里创建：浏览器同源 fetch 会带 sec-fetch-site，脚本/工具默认不带。
          if (action === 'create') {
            const site = String((req.headers && req.headers['sec-fetch-site']) || '');
            const ui = String((req.headers && req.headers['x-dsh-ui']) || '');
            const origin = String((req.headers && req.headers.origin) || '');
            let sameOrigin = false;
            if (origin) {
              try { sameOrigin = new URL(origin).host === String((req.headers && req.headers.host) || ''); } catch { sameOrigin = false; }
            }
            if (site !== 'same-origin' && site !== 'none' && ui !== '1' && !sameOrigin) {
              sendJson(res, 403, { ok: false, message: '任务只能由用户在插件面板里创建；AI 只能在已有任务里记账。' });
              return;
            }
          }
          let result;
          let kick = { kicked: false };
          if (action === "create") {
            result = campaigns.create(body || {});
            const agents = liveAgents().filter((a) => a && a.id);
            const target = body.sessionId ? agents.find((a) => a.id === body.sessionId) : (agents.length === 1 ? agents[0] : null);
            if (target) {
              result = campaigns.bind(result.id, target.id);
              kick = await kickAgent(target, result);
              if (kick && kick.kicked) scheduleAutopilot(result.id);
            } else if (agents.length > 1) {
              kick = { kicked: false, reason: "有多个对话在线，请点「让 AI 开始」指定是哪一个" };
            }
          }
          else if (action === 'patch') result = campaigns.patch(body.id, body || {});
          else if (action === 'asset') result = campaigns.upsertAsset(body.id, body || {});
          else if (action === 'step') result = campaigns.addStep(body.id, body || {});
          else if (action === 'attempt') result = campaigns.addAttempt(body.id, body || {});
          else if (action === 'delete') { campaigns.remove(body.id); sendJson(res, 200, { ok: true, proto: API_PROTO, ...campaigns.list() }); return; }
          else if (action === "advance") {
            const moved = campaigns.advance(body.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, item: moved.campaign, stage: { from: moved.from, to: moved.to, changed: moved.changed }, ...campaigns.list() });
            return;
          }
          else if (action === "done") {
            const campaign = campaigns.markDone(body.id, body.note || '');
            stopAutopilot(campaign.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, item: campaign, ...campaigns.list() });
            return;
          }
          else if (action === "autopilot") {
            const campaign = campaigns.patch(body.id, { autopilot: body.on !== false });
            if (campaign.autopilot && !campaign.done) scheduleAutopilot(campaign.id);
            else stopAutopilot(campaign.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, item: campaign, autopilot: campaign.autopilot });
            return;
          }
          else if (action === "tick") {
            const tick = autopilotTick(body.id);
            if (tick.ticked) scheduleAutopilot(body.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, tick });
            return;
          }
          else if (action === "next") { sendJson(res, 200, { ok: true, proto: API_PROTO, next: campaigns.nextStep(body.id, availableKbIndex) }); return; }
          else if (action === "bind") {
            const explicit = String(body.sessionId || '');
            if (!explicit) { sendJson(res, 400, { ok: false, message: "绑定需要明确 sessionId：在那个对话里说「绑任务 X」，或先只保留一个对话。" }); return; }
            const bound = campaigns.bind(body.id, explicit);
            const agent = liveAgents().find((a) => a.id === bound.sessionId);
            kick = agent ? await kickAgent(agent, bound) : { kicked: false, reason: "该会话不在线" };
            if (bound.autopilot !== false && !bound.done) scheduleAutopilot(bound.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, item: bound, kicked: kick.kicked, kickReason: kick.reason, ...campaigns.list() });
            return;
          }
          else if (action === "unbind") {
            const campaign = campaigns.unbind(body.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, item: campaign, ...campaigns.list() });
            return;
          }
          else if (action === "kick") {
            const campaign = campaigns.get(body.id);
            const agent = liveAgents().find((a) => a.id === campaign.sessionId);
            const kicked = agent ? await kickAgent(agent, campaign) : { kicked: false, reason: "任务还没有绑定在线会话" };
            if (kicked && kicked.kicked) scheduleAutopilot(campaign.id);
            sendJson(res, 200, { ok: true, proto: API_PROTO, kicked: kicked.kicked, kickReason: kicked.reason, item: campaign });
            return;
          }
          else { sendJson(res, 400, { ok: false, message: '不支持的 action：' + action }); return; }
          sendJson(res, 200, { ok: true, proto: API_PROTO, item: result, kicked: kick.kicked, kickReason: kick.reason, ...campaigns.list() });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
    });

    // 漏洞报告：GET 读、POST 写（upsert / delete / clear / status）、导出 markdown。
    route(FINDINGS_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        sendJson(res, 200, { proto: API_PROTO, ...findings.reload() });
        return;
      }
      if (req.method === 'POST') {
        try {
          const body = await readBody(req, 512 * 1024);
          const action = body && typeof body.action === 'string' ? body.action : 'upsert';
          if (action === 'upsert') findings.upsert(body);
          else if (action === 'delete') findings.remove(body.id);
          else if (action === 'clear') findings.clear();
          else if (action === 'status') findings.setStatus(body.id, body.status);
          else { sendJson(res, 400, { ok: false, message: '不支持的 action：' + action }); return; }
          sendJson(res, 200, { proto: API_PROTO, ...findings.snapshot() });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
    });

    route(FINDINGS_MD_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
      try {
        const data = Buffer.from(findings.toMarkdown(), 'utf8');
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="vuln-report.md"',
          'cache-control': 'no-store',
          'content-length': String(data.length)
        });
        res.end(data);
      } catch (error) {
        sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
      }
    });

    // 知识库页签专用：只读目录（分类 + 条目 title/severity/entry），并回传开关状态。
    route(KNOWLEDGE_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
      try {
        const all = knowledgeLibrary.catalog();
        const knowledge = knowledgeLibrary.snapshot().skills[0] || {};
        const enabled = knowledge.enabled === true;
        const available = all.reduce((sum, item) => sum + item.count, 0);
        const categories = enabled ? all : [];
        sendJson(res, 200, {
          ok: true,
          proto: API_PROTO,
          total: enabled ? available : 0,
          available,
          categories,
          enabled,
          busy: knowledge.busy === true,
          phase: knowledge.phase || null,
          version: knowledge.version || null,
          message: knowledge.message || null
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
      }
    });

    route(CONFIG_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method === 'GET' || req.method === 'HEAD') {
        // 以磁盘为准回读一次，保证多窗口一致。
        // 注意：只更新 live 是不够的 —— 磁盘被本实例 POST 之外的方式改过（手工编辑、
        // 或另一个共享同一 $DSH_HOME 的进程写入）时，已注册的 scoped 节还停在旧形态，
        // 会出现「armed:false 但 injected:1」这种自相矛盾，甚至把官方人设整段抹掉。
        // 所以回读之后必须把注入形态对齐一次（形态没变时 installInner 会直接早退）。
        const fromDisk = readFileConfig();
        if (fromDisk) live = normalize({ ...live, ...fromDisk });
        await refreshKnownVars();
        await reinstallAll();
        sendJson(res, 200, { ok: true, config: live, ...status(), ...variableWarnings() });
        return;
      }
      if (req.method === 'POST') {
        try {
          // 上限 2MB：主文本 + 最多 50 张卡片。默认 256KB 对卡片集太紧。
          const body = await readBody(req, 2 * 1024 * 1024);
          // 部分更新语义：body 里哪个字段在场就更新哪个（setConfig 会与 live 合并）。
          // cards 只认数组：非数组（客户端 bug / 手写请求 / 旧客户端残留）strip 掉，
          // 不得把磁盘上已有的卡片清空 —— 与「非破坏性写盘」同一条立场。
          const patch = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
          if ('cards' in patch && !Array.isArray(patch.cards)) delete patch.cards;
          const saved = await setConfig(patch);
          await refreshKnownVars();
          sendJson(res, 200, { ok: true, config: saved, ...status(), ...variableWarnings() });
        } catch (error) {
          sendJson(res, 400, { ok: false, message: String((error && error.message) || error) });
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
    });

    // 预览分两份，语义必须分开：
    //   official  = assemble({})，**不含**按 agent 注入的自定义节 → 就是「官方提示词」，
    //               供用户对照着写替换内容（按钮的本来用途）。
    //   effective = assemble({agent, scope: agent})，模型这一步真正看到的全文，
    //               替换模式下能看出官方 persona 确实被遮蔽了。
    // 早期版本只返回后者并把它当 text 用，于是「预览官方提示词」里出现的是用户自己的文案 —— 已修正。
    route(PREVIEW_ROUTE, async (req, res) => {
      if (!isLoopback(req)) { res.writeHead(403); res.end('forbidden'); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD' }); res.end(); return; }
      let agent = lastAgent && entries.has(lastAgent) ? lastAgent : null;
      if (!agent) { for (const a of entries.keys()) { agent = a; break; } }
      try {
        const sink = newSink();
        const officialAssembly = await ctx.systemPrompt.assemble({});
        const official = renderSections(officialAssembly, sink);
        let effective = official;
        let sections = sectionNames(officialAssembly);
        if (agent) {
          const scopedAssembly = await ctx.systemPrompt.assemble({ agent, scope: agent });
          effective = renderSections(scopedAssembly, sink);
          sections = sectionNames(scopedAssembly);
        }
        // 单独扫一遍用户自己写的文本：它会以函数形式注入，写错变量会让每一步装配都抛错。
        await refreshKnownVars();
        sendJson(res, 200, {
          ok: true,
          official,
          effective,
          // 兼容字段：text 固定给 official（旧客户端的按钮语义就是「官方提示词」）
          text: official,
          scoped: !!agent,
          agentId: agent ? (agent.id || null) : null,
          sections,
          ...variableWarnings(),
          ...status()
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, message: String((error && error.message) || error) });
      }
    });
  });
  // 原生工具是可选增强：拿不到 dsh-tools 就静默退回 HTTP。
  registerAutomationTools(ctx, { kbIndex: availableKbIndex, campaigns, findings, skillIndex }).then((result) => {
    automationTools = result;
    if (result.ok) log('[dsh-prompt-custom] 已注册原生工具：' + result.registered.join(', '));
    else warn('[dsh-prompt-custom] 原生工具未启用（HTTP 仍可用）：' + result.reason);
  }).catch((error) => {
    automationTools = { ok: false, reason: String((error && error.message) || error) };
    warn('[dsh-prompt-custom] 原生工具注册异常：' + automationTools.reason);
  });
}
