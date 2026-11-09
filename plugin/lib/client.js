// dsh-prompt-custom（独立移植版）— client 半边：设置页「自定义提示词」栏。
//
// 0.5.0 重做（用户裁定「卡片即提示词」）—— 交互与视觉同时回炉：
//
// 一、交互（0.4.0 的差在哪）：卡片列表 + 「使用这张」+ 独立保存按钮的三件套叠出四层状态 ——
//   卡片高亮只认「文本恰好相等」，「保存」只写正文不写卡片，于是「编辑→保存→卡片还停在旧
//   文本上」看起来像丢字；切换卡片要跨半屏去找「使用这张」；编辑框有改动时还得先处置一次。
//   最常用的两个动作（切卡 / 存正文）各走各的门，却互相不知道对方。
//   本版把卡片抬成**唯一的正文选择器**：
//   1. 卡片是可点选的芯片：点一下 = 切换为该卡正文 + 立即生效（编辑框干净时一次 POST）。
//      编辑框有未保存改动时给三个出口（保存并切换 / 另存为卡片并切换 / 丢弃改动并切换），
//      每个出口都写清后果，不再有「点了没反应」的中间态。
//   2. 「保存」写回**当前卡**（正文来自哪张卡就写回哪张），按钮上直接写目标
//      （「保存到「卡片甲」并生效」）；正文不属于任何卡片时写「保存并生效」。
//      卡片不再是一次性快照，编辑→保存→卡片同步，闭环成立。
//   3. 「新建卡片」存编辑框当前内容，并成为当前生效；分叉场景走切换面板里的「另存为卡片」。
//   4. 改名 / 删除收进「当前生效」那一行的行内操作（操作对象 = 当前卡），不再每张卡挂三颗按钮。
//   5. 预览折叠成一行，展开后在「官方全文 / 实际生效」间切换；需要对照时才占版面。
//
// 二、视觉：全套内核设计系统原语（Button / Switch / SegmentedControl / Input / Pill / Tag /
//   DisclosureRow + 官方图标），颜色与圆角走 --dsw-* 变量 —— 与「内置插件」等既有设置页同语言，
//   不再是自绘 checkbox / select。
//
// 三、宿主与协议**完全不动**（lib/index.js、API_PROTO=3、$DSH_HOME/prompt-custom.json 文件格式
//   全不变）：纯界面重做，老配置原样可用；宿主没重启（proto≠3）时卡片区照旧整体禁用并说清原因。
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-prompt-custom",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");
    // 内核设计系统原语（与 dsh-wsl-settings 等伴随插件同款引入姿势：顶部一次性引入）。
    const {
      Button, Switch, SegmentedControl, SegmentedTabs, Input, Pill, Tag, DisclosureRow, Modal,
      IconPlusOutlineRegular, IconChevronDownOutlineRegular,
      IconSettingsOutlineRegular, IconCloseOutlineRegular, IconSkillOutlineRegular
    } = require("@deepseek-ai/dsh-client-ui-primitives");

    const CONFIG_URL = "/api/dsh-prompt-custom/config";
    const PREVIEW_URL = "/api/dsh-prompt-custom/preview";
    const TOGGLE_URL = "/api/dsh-prompt-custom/toggle";
    const SKILLS_URL = "/api/dsh-prompt-custom/skills";
    const KNOWLEDGE_URL = "/api/dsh-prompt-custom/knowledge";
    const FINDINGS_URL = "/api/dsh-prompt-custom/findings";
    const FINDINGS_MD_URL = "/api/dsh-prompt-custom/findings.md";
    const CAMPAIGNS_URL = "/api/dsh-prompt-custom/campaigns";
    const SESSIONS_URL = "/api/dsh-prompt-custom/sessions";
    // 必须与 host 半边的 API_PROTO 一致。改协议号时**只改两处**：host 的 API_PROTO、这里的 EXPECT_PROTO。
    // 3 (0.4.0): config added cards; 4 adds the prompt-free composer toggle route.
    const EXPECT_PROTO = 11;

    const L = {
      nav: "自定义提示词",
      title: "自定义提示词",
      sub: "编辑注入内核的系统提示词：追加到默认人设之后，或整体替换默认人设。开关与注入方式即时生效；正文改动对下一次模型装配生效，无需新建会话。",
      enabled: "启用自定义提示词",
      enabledHint: "关闭后回落为官方默认提示词（即时生效，不需要点保存）",
      toggleLabel: "富江破甲",
      toggleError: "开关状态读取失败",
      toggleRetry: "重试",
      toggleOn: "已激活",
      toggleOff: "未激活",
      toggleLoading: "加载中",
      knowledgeTitle: "知识库",
      knowledgeHint: "CVE / PoC 语料随插件分发（离线，不下载、不联网）。开启后模型可在 skills 目录里直接调用这些分类技能；正文只在被调用时进入上下文，平时只占目录里的一行描述。",
      knowledgeTotal: (n, m) => m + " 个分类 · " + n + " 条",
      knowledgeOn: "已注入：模型可从 skills 目录直接调用这些分类。",
      knowledgeOff: "已关闭：分类技能不在模型目录里，语料仍保留在插件目录。",
      knowledgeEmpty: "还没有加载到分类。",
      knowledgeRestart: "若刚更新过插件，请完全退出 DSH 再启动。",
      knowledgeLoading: "加载中…",
      reportTitle: "漏洞报告",
      reportSub: "AI 在会话里找到的漏洞会写进这里（严重 / 高危 / 中危 / 低危 / 信息），可按严重度筛选、改状态、导出 Markdown。",
      reportEmpty: "还没有任何条目。AI 找到漏洞后会自动写入；也可以直接用下面的命令手工补一条。",
      reportTotal: (n, open) => "共 " + n + " 条 · 未修复 " + open,
      reportAll: "全部",
      reportExport: "导出 Markdown",
      reportClear: "清空报告",
      reportClearAsk: "清空整份漏洞报告？此操作立即生效且无法撤回。",
      reportHint: "AI 写入方式（一条命令即可）",
      reportStatusOpen: "未修复",
      reportStatusFixed: "已修复",
      reportStatusAccepted: "已接受风险",
      reportStatusFalse: "误报",
      reportDelete: "删除",
      reportVerify: "已验证",
      reportUnverified: "未验证",
      reportLoading: "加载中…",
      reportSearchPlaceholder: "搜索标题 / 目标 / URL / CVE",
      reportNoMatch: "没有匹配的条目。",
      reportUpdated: (t) => "最近更新 " + t,
      reportSource: "来源",
      reportCvss: "CVSS",
      reportDetailDescription: "描述",
      reportDetailEvidence: "证据",
      reportDetailRemediation: "修复建议",
      reportDetailRefs: "参考",
      reportAiHint: "AI 写入示例（复制即用）",
      taskTitle: "渗透作业链",
      taskNew: "新建任务",
      taskEmpty: "还没有任务。任务只能由你在这里新建：填好目标域名/网段，AI 才会在任务里按「信息收集 → 指纹识别 → 漏洞匹配 → 可行性验证 → 漏洞利用 → 横向移动 → 报告输出」推进。",
      taskLoading: "加载中…",
      taskStage: "阶段",
      taskNext: "下一阶段",
      taskDelete: "删除任务",
      taskDeleteAsk: "删除这个任务？台账会一起删掉，已写入漏洞报告的条目不受影响。",
      taskAssets: "资产",
      taskSteps: "步骤",
      taskScope: "范围",
      taskSuggest: "下一步建议",
      taskNoAdvice: "台账里还没有可推进的内容：先写入资产（host/port/指纹）。",
      taskNamePlaceholder: "任务名，例如 oa.example.com 外网打点",
      taskPrev: "上一阶段",
      taskObjective: "目标：",
      taskDone: "标记完成",
      taskDoneHint: "目标达成后点这里，自动续跑会停。",
      taskBind: "绑定",
      taskBindPick: "绑定到：",
      taskKick: "让 AI 开始",
      taskKicked: "已把「开始执行」推给 AI，它会先给计划。",
      taskKickHint: "提示：",
      taskUnbind: "解绑",
      taskBound: "已绑定会话：",
      taskUnbound: "未绑定对话：在对话输入框左侧的任务条里点「绑定任务」，只绑当前对话",
      taskProgress: "进度",
      taskScopePlaceholder: "目标范围：域名或 IP 段，逗号分隔（可留空，稍后补）",
      taskCreate: "创建",
      taskCancel: "取消",
      taskCreateHint: "任务只能由你创建。创建后 AI 才能在任务里写资产、记步骤、推进阶段。",
      pluginSettings: "富江破甲设置",
      pluginFunctions: "插件功能",
      pluginSettingsHint: "插件设置",
      closeSettings: "关闭富江破甲设置",
      skillsTitle: "技能库",
      skillsEmpty: "还没有添加技能",
      skillsEmptyHint: "添加的技能会显示在这里。",
      mode: "注入方式",
      modeHint: "追加 = 保留默认人设；替换 = 覆盖默认人设。切换即时生效（挂载点不同，会重新注入）。",
      modeAppend: "追加到末尾",
      modeReplace: "替换整体",
      text: "提示词内容",
      textHint: "按原样注入；可用 {{model}} {{cwd}} 等内核变量。",
      savePlain: "保存并生效",
      saveTo: (name) => "保存到「" + name + "」并生效",
      revert: "还原改动",
      saving: "应用中…",
      saved: "已保存并生效",
      savedToCard: (name) => "已保存到卡片「" + name + "」并生效。",
      loading: "加载中…",
      unavailable: "设置不可用（需要在本机浏览器中打开）",
      dirtyTag: "未保存",
      previewTitle: "预览",
      previewOfficial: "官方全文",
      previewEffective: "实际生效",
      previewHintOfficial: "官方全文，不含本插件的自定义节 —— 对照着写替换内容用。",
      previewHintEffective: "模型这一步真正看到的全文（已含自定义节）。",
      previewReload: "重新加载",
      previewing: "加载中…",
      previewNoAgent: "当前没有活动会话，暂时只能看到全局视图；新建会话后再看「实际生效」更准。",
      staleHost: "⚠ 界面与宿主插件版本不一致：页面已经刷新（新界面），但宿主进程没有重启（旧插件）。请**完全退出** DeepSeek Harness（含托盘/任务管理器里的残留进程）再启动 —— 只刷新页面不会重载宿主插件。重启之前：预览可能退化为旧接口的文本，提示词卡无法使用。",
      unknownCfgKeys: (keys) => "⚠ 配置文件里有本版本不认识的字段：" + keys + "。这通常说明该文件是**另一个版本**的插件写的 —— 当前版本可能没有读到你先前的设置。请先备份配置文件再继续操作。",
      previewError: "预览加载失败",
      varWarn: (names) => "警告：这些变量内核不认识 —— " + names + "。内核遇到未知变量会直接报错，导致每一轮运行失败，请改成正确的变量名或删掉。",
      varMalformed: (names) => "警告：这些引用写法不合法 —— " + names + "。变量名只能是 [a-z][a-z0-9_]*。",
      storage: "配置文件",
      stOff: "已停用：回落为官方默认提示词",
      stArmed: "已启用：新建会话时自动注入",
      stInjected: (n) => "已生效：当前 " + n + " 个会话已注入",
      stError: (m) => "注入失败：" + m,
      cardsTitle: "提示词卡",
      cardsHint: "点卡片即切换并生效；正文改动用下方按钮写回当前卡。",
      cardsAdd: "新建卡片",
      cardsEmpty: "还没有提示词卡。把编辑好的提示词「新建卡片」存起来，之后点一下卡片就能切换。",
      cardsVirtual: "当前正文",
      cardsCurrent: (name, len) => "当前生效：卡片「" + name + "」 · " + len + " 字符",
      cardsCurrentCustom: (len) => "当前正文：自定义（未存入卡片） · " + len + " 字符",
      cardsCurrentNone: "当前正文为空",
      cardsRename: "改名",
      cardsRemove: "删除",
      cardsRenameLabel: "新名字",
      cardsNamePlaceholder: "给卡片起个名字（留空自动命名）",
      cardsRenameSave: "保存名字",
      cardsCancel: "取消",
      cardsRemoveAsk: (name) => "删除卡片「" + name + "」？删除后无法撤回。",
      cardsRemoveConfirm: "确认删除",
      cardsAddHint: "存的是编辑框里的当前内容（含未保存改动），并存为当前生效。",
      cardsSave: "存为卡片",
      cardsNoteAdded: (name) => "已存为卡片「" + name + "」并生效。",
      cardsNoteUsed: (name) => "已切换到卡片「" + name + "」并生效。",
      cardsNoteSavedSwitched: (saved, used) => "已保存到卡片「" + saved + "」，并切换到「" + used + "」。",
      cardsNoteForkedSwitched: (forked, used) => "已另存为新卡「" + forked + "」，并切换到「" + used + "」。",
      cardsNoteRemoved: (name) => "卡片「" + name + "」已删除。",
      cardsNoteRenamed: (name) => "卡片已改名为「" + name + "」。",
      cardsUseDirty: "编辑框里有未保存的改动，切换卡片前先处置：",
      cardsSwitchSave: (name) => "保存到「" + name + "」并切换",
      cardsSwitchFork: "另存为卡片并切换",
      cardsSwitchDiscard: "丢弃改动并切换",
      cardsLimit: "卡片数量已达上限（最多 50 张）。",
      cardsStale: "宿主插件还是旧版本，提示词卡暂时无法使用 —— 请完全退出 DeepSeek Harness 再启动后使用。"
    };

    /** 把 /config 返回的 armed / injected / lastError 翻成一句人能看懂的状态。 */
    function statusLine(st) {
      if (!st) return null;
      if (st.lastError) return { text: L.stError(st.lastError), tone: "error" };
      // 旧版 host 不返回 armed/injected：这时无从判断，宁可不显示，
      // 也不要因为 !undefined 而谎报「已停用」（跨版本混装时会反向骗人）。
      if (st.armed === undefined && st.injected === undefined) return null;
      if (!st.armed) return { text: L.stOff, tone: "muted" };
      if (st.injected > 0) return { text: L.stInjected(st.injected), tone: "ok" };
      return { text: L.stArmed, tone: "muted" };
    }

    // 提示词卡上限：必须与 host 的 MAX_CARDS 一致（宿主会截断，这里先把入口封住）。
    const CARDS_MAX = 50;

    /** 卡片 id：本机自用、与后端无耦合；形状与 host 的 CARD_ID 校验正则配对。 */
    function newCardId() {
      return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** 名字建议：取第一行（去掉标题符号）截 24 字符；没有内容就按序号兜底。 */
    function suggestName(text, count) {
      const line = String(text || "")
        .split("\n")
        .map((s) => s.replace(/^#+\s*/, "").trim())
        .find((s) => s.length > 0) || "";
      return line ? line.slice(0, 24) : "提示词卡 " + (count + 1);
    }

    function note(text, tone) {
      return jsx("div", {
        style: {
          fontSize: 12,
          lineHeight: "18px",
          color: tone === "error" ? "var(--dsw-alias-label-error)"
            : (tone === "warn" ? "var(--dsw-alias-state-warn-primary)" : undefined),
          opacity: tone === "muted" ? 0.75 : 1,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word"
        },
        children: text
      });
    }

    // 内联样式：颜色与圆角走内核设计系统变量（--dsw-*），与「内置插件」等既有设置页同语言。
    const S = {
      root: { display: "flex", flexDirection: "column", gap: 14, padding: 16, maxWidth: 720 },
      head: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      h2: { margin: 0, fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      sub: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      hint: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" },
      field: { display: "flex", flexDirection: "column", gap: 6 },
      fieldTitle: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
      row: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      panel: {
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 10px",
        border: "1px solid var(--dsw-alias-border-l3)",
        borderRadius: "var(--dsw-radius-md)",
        background: "var(--dsw-alias-bg-layer-3)"
      },
      warnPanel: {
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "8px 10px",
        border: "1px solid var(--dsw-alias-state-warn-primary)",
        borderRadius: "var(--dsw-radius-md)",
        background: "var(--dsw-alias-bg-layer-3)"
      },
      textarea: {
        width: "100%", boxSizing: "border-box", padding: "8px 10px",
        fontFamily: "inherit", fontSize: 13, lineHeight: "20px",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "var(--dsw-radius-md)",
        resize: "vertical", outline: "none"
      },
      mono: {
        width: "100%", boxSizing: "border-box", padding: "8px 10px",
        fontFamily: "monospace, inherit", fontSize: 12, lineHeight: "18px",
        color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-2)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: "var(--dsw-radius-md)",
        resize: "vertical", outline: "none"
      }
    };

    const EMPTY = { enabled: false, mode: "append", text: "", cards: [] };

    function Card({ embedded = false, sessionId = "" } = {}) {
      const [cfg, setCfg] = react.useState(EMPTY);           // 编辑框态（正文可能未保存）
      const [savedCfg, setSavedCfg] = react.useState(EMPTY); // 服务端已保存的配置（卡片真值）
      const [state, setState] = react.useState("loading");
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState("");
      const [sessions, setSessions] = react.useState([]);
      const [pick, setPick] = react.useState("");
      const [cardNotice, setCardNotice] = react.useState("");
      const [vars, setVars] = react.useState({ unknown: [], malformed: [] });
      const [file, setFile] = react.useState("");
      const [st, setSt] = react.useState(null);
      // 宿主进程没重启、页面却刷新过时，接口会缺字段（见 L.staleHost）。
      const [stale, setStale] = react.useState(false);
      // 配置文件里有本版本不认识的键（配置 schema 演进的保护，见 L.unknownCfgKeys）。
      const [cfgKeys, setCfgKeys] = react.useState([]);
      // 预览：默认收起，展开后按需拉取（懒加载，不常驻半屏高度）。
      const [previewOpen, setPreviewOpen] = react.useState(false);
      const [previewKind, setPreviewKind] = react.useState("official");
      const [preview, setPreview] = react.useState(null);    // { kind, text, error }
      const [previewBusy, setPreviewBusy] = react.useState(false);
      // 卡片区的瞬时 UI 状态（卡片真值只在 savedCfg.cards，这里全是过程态）。
      const [adding, setAdding] = react.useState(false);    // 「新建卡片」面板展开
      const [newName, setNewName] = react.useState("");
      const [pending, setPending] = react.useState(null);   // 待确认 { kind: "use"|"remove"|"rename", id }
      const [renameText, setRenameText] = react.useState("");

      const applyStatus = (data) => {
        setSt({ armed: data.armed, injected: data.injected, lastError: data.lastError });
        setVars({ unknown: data.unknownVariables || [], malformed: data.malformedVariables || [] });
        setCfgKeys(data.unknownConfigKeys || []);
      };

      // 尽最大努力识别"当前对话"：扫 localStorage 里含 session 的键，取第一个 session-<uuid>。
      const guessSession = () => {
        if (sessionIdHint) return sessionIdHint;
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i) || "";
            if (!/session/i.test(key)) continue;
            const raw = localStorage.getItem(key) || "";
            const hit = /session-[0-9a-f-]{36}/i.exec(raw);
            if (hit) return hit[0];
          }
        } catch (_) { /* ignore */ }
        return "";
      };

      const loadSessions = react.useCallback(async () => {
        try {
          const resp = await fetch(SESSIONS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          const list = Array.isArray(json && json.sessions) ? json.sessions : [];
          setSessions(list);
          setPick((prev) => prev || (list.some((x) => x.id === guessSession()) ? guessSession() : (list[0] && list[0].id) || ""));
        } catch (_) { /* ignore */ }
      }, []);
      const load = react.useCallback(async () => {
        try {
          const resp = await fetch(CONFIG_URL, { headers: { accept: "application/json" } });
          const data = await resp.json();
          if (!resp.ok || !data || data.ok === false) { setState("error"); return; }
          const c = data.config || EMPTY;
          setCfg(c);
          setSavedCfg(c);
          setFile(data.path || "");
          setStale(data.proto !== EXPECT_PROTO);
          applyStatus(data);
          setState("ready");
        } catch (e) { setState("error"); }
      }, []);

      react.useEffect(() => { load(); }, [load]);

      const loadPreview = react.useCallback(async (kind) => {
        setPreviewBusy(true);
        try {
          const resp = await fetch(PREVIEW_URL, { headers: { accept: "application/json" } });
          const data = await resp.json();
          if (!resp.ok || !data || data.ok === false) throw new Error((data && data.message) || ("HTTP " + resp.status));
          // 宿主旧接口只有 text：退化为它，而不是显示一个空框让用户猜。
          const fromNew = kind === "effective" ? data.effective : data.official;
          const text = fromNew !== undefined ? fromNew : data.text;
          setPreview({ kind: kind, text: String(text || "(空)") });
          setStale(data.proto !== EXPECT_PROTO);
          applyStatus(data);
        } catch (e) {
          setPreview({ kind: kind, text: L.previewError + ": " + String((e && e.message) || e), error: true });
        } finally { setPreviewBusy(false); }
      }, []);

      // preview 在 post 的闭包里会是旧值，用 ref 取当前显示的预览类型。
      const previewRef = react.useRef(null);
      react.useEffect(() => { previewRef.current = preview; }, [preview]);

      /** 统一的写入口。成功后对齐已保存态、刷新加载过的预览；失败返回 null 并把原文摆到界面上。 */
      const post = async (body) => {
        const payload = {
          enabled: !!body.enabled,
          mode: body.mode === "replace" ? "replace" : "append",
          text: String(body.text || "")
        };
        // cards 只按数组透传（卡片类操作才带）：正文/开关操作不碰卡片集，
        // 宿主对「未提供」与「非数组」两侧都有保护（见 index.js 的 POST 路由）。
        if (Array.isArray(body.cards)) payload.cards = body.cards;
        setBusy(true); setNotice("");
        try {
          const resp = await fetch(CONFIG_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload)
          });
          const data = await resp.json();
          if (!resp.ok || !data || data.ok === false) throw new Error((data && data.message) || ("HTTP " + resp.status));
          setSavedCfg(data.config || body);
          applyStatus(data);
          const shown = previewRef.current;
          if (shown && !shown.error) loadPreview(shown.kind); // 已加载过的预览不许停在旧文本上
          return data;
        } catch (e) {
          setNotice(String((e && e.message) || e));
          return null;
        } finally { setBusy(false); }
      };

      /**
       * 开关 / 模式即时生效。正文一律用**已保存**的那份，
       * 避免把用户编辑到一半、还没点保存的内容偷偷写进去。
       */
      const applyShape = async (patch) => {
        const next = {
          enabled: patch.enabled !== undefined ? patch.enabled : savedCfg.enabled,
          mode: patch.mode !== undefined ? patch.mode : savedCfg.mode,
          text: savedCfg.text
        };
        setCfg((prev) => Object.assign({}, prev, patch));
        const ok = await post(next);
        if (!ok) {
          // 失败就把开关/模式拉回服务端真实状态，绝不让界面显示一个没生效的值。
          setCfg((prev) => Object.assign({}, prev, { enabled: savedCfg.enabled, mode: savedCfg.mode }));
        }
      };

      // ---- 派生状态 ----
      const liveText = String(savedCfg.text || "");   // 已保存正文（模型真正吃到的）
      const editorText = String(cfg.text || "");      // 编辑框里的（可能未保存）
      const dirtyText = editorText !== liveText;
      const cards = Array.isArray(savedCfg.cards) ? savedCfg.cards : [];
      // 「当前卡」= 已保存正文恰好等于某张卡的文本；空正文不认卡（避免把空卡误标高亮）。
      const activeCard = liveText !== ""
        ? (cards.find((c) => String(c.text || "") === liveText) || null)
        : null;
      const pendingCard = pending ? (cards.find((c) => c.id === pending.id) || null) : null;
      const cardsGated = busy || stale;               // stale = 旧宿主会静默丢 cards，一律禁写
      const cardUiBusy = cardsGated || !!pendingCard || adding;
      const saveLabel = (activeCard && !stale) ? L.saveTo(activeCard.name) : L.savePlain;

      /** 切换：把该卡文本设为「已保存正文」并立即生效（成功回应才动编辑框）。 */
      const applyCardText = async (card) => {
        const text = String(card.text || "");
        const ok = await post({ enabled: savedCfg.enabled, mode: savedCfg.mode, text: text });
        if (ok) {
          setCfg((prev) => Object.assign({}, prev, { text: text }));
          setCardNotice(L.cardsNoteUsed(card.name));
          setPending(null);
        }
        return ok;
      };

      /** 点芯片：切换并立即生效；编辑框有未保存改动时先停下，三个出口都摆明后果。 */
      const useCard = (card) => {
        if (cardUiBusy || !card) return;
        if (activeCard && card.id === activeCard.id) return; // 点当前卡＝无操作
        if (dirtyText) { setCardNotice(""); setPending({ kind: "use", id: card.id }); return; }
        return applyCardText(card);
      };

      /** 三选①「保存到当前卡并切换」：一次 POST 写回当前卡 + 切到目标卡。 */
      const switchSaving = async () => {
        const target = pendingCard;
        if (!target || !activeCard || cardsGated) return;
        const ok = await post({
          enabled: savedCfg.enabled, mode: savedCfg.mode, text: String(target.text || ""),
          cards: cards.map((c) => (c.id === activeCard.id ? Object.assign({}, c, { text: editorText }) : c))
        });
        if (ok) {
          setCfg((prev) => Object.assign({}, prev, { text: String(target.text || "") }));
          setCardNotice(L.cardsNoteSavedSwitched(activeCard.name, target.name));
          setPending(null);
        }
      };

      /** 三选②「另存为卡片并切换」：编辑框内容存为新卡，再切到目标卡（一次 POST）。 */
      const switchForking = async () => {
        const target = pendingCard;
        if (!target || cardsGated || cards.length >= CARDS_MAX) return;
        const name = suggestName(editorText, cards.length);
        const fork = { id: newCardId(), name: name, text: editorText };
        const ok = await post({
          enabled: savedCfg.enabled, mode: savedCfg.mode, text: String(target.text || ""),
          cards: cards.concat([fork])
        });
        if (ok) {
          setCfg((prev) => Object.assign({}, prev, { text: String(target.text || "") }));
          setCardNotice(L.cardsNoteForkedSwitched(name, target.name));
          setPending(null);
        }
      };

      /** 三选③「丢弃改动并切换」：直接切到目标卡，未保存编辑随成功回应被覆盖。 */
      const switchDiscarding = () => {
        const target = pendingCard;
        if (!target || cardsGated) return;
        return applyCardText(target);
      };

      const openAdd = () => {
        if (cardsGated || cards.length >= CARDS_MAX) return;
        setCardNotice("");
        setPending(null);
        setNewName(suggestName(editorText, cards.length));
        setAdding(true);
      };

      const cancelAdd = () => { setAdding(false); setNewName(""); };

      /** 「存为卡片」：存的是编辑框当前内容（含未保存改动），并成为当前生效。 */
      const submitAdd = async () => {
        if (cardsGated || cards.length >= CARDS_MAX) return;
        const name = newName.trim() || suggestName(editorText, cards.length);
        const card = { id: newCardId(), name: name, text: editorText };
        const ok = await post({
          enabled: savedCfg.enabled, mode: savedCfg.mode, text: editorText,
          cards: cards.concat([card])
        });
        if (ok) {
          setCardNotice(L.cardsNoteAdded(name));
          cancelAdd();
        }
      };

      const openRename = (card) => {
        if (cardUiBusy || !card) return;
        setCardNotice("");
        setRenameText(String(card.name || ""));
        setPending({ kind: "rename", id: card.id });
      };

      /** 改名：只动名字，正文与其他字段不动。 */
      const submitRename = async () => {
        const target = pendingCard;
        if (!target || cardsGated) return;
        const name = renameText.trim() || target.name;
        const ok = await post({
          enabled: savedCfg.enabled, mode: savedCfg.mode, text: liveText,
          cards: cards.map((c) => (c.id === target.id ? Object.assign({}, c, { name: name }) : c))
        });
        if (ok) {
          setCardNotice(L.cardsNoteRenamed(name));
          setPending(null);
        }
      };

      const openRemove = (card) => {
        if (cardUiBusy || !card) return;
        setCardNotice("");
        setPending({ kind: "remove", id: card.id });
      };

      /** 删除：二次确认后写盘；删的是当前卡时正文留在原地（只是不再属于任何卡）。 */
      const submitRemove = async () => {
        const target = pendingCard;
        if (!target || cardsGated) return;
        const ok = await post({
          enabled: savedCfg.enabled, mode: savedCfg.mode, text: liveText,
          cards: cards.filter((c) => c.id !== target.id)
        });
        if (ok) {
          setCardNotice(L.cardsNoteRemoved(target.name));
          setPending(null);
        }
      };

      /**
       * 保存正文：正文来自某张卡时**同时写回该卡**（编辑→保存→卡片同步的闭环）；
       * stale（旧宿主不认 cards）时只保存正文，不演「存了卡片」。
       */
      const save = async () => {
        if (busy) return;
        const target = stale ? null : activeCard;
        const next = { enabled: cfg.enabled, mode: cfg.mode, text: editorText };
        if (target) next.cards = cards.map((c) => (c.id === target.id ? Object.assign({}, c, { text: editorText }) : c));
        const ok = await post(next);
        if (ok && !ok.lastError) setNotice(target ? L.savedToCard(target.name) : L.saved);
      };

      /** 还原改动：编辑框拉回已保存正文（不动服务端）。 */
      const revert = () => setCfg((prev) => Object.assign({}, prev, { text: liveText }));

      /** 展开预览时懒加载一次；已加载过的不重复抓（改动生效时 post 会自动刷新）。 */
      const togglePreview = () => {
        const next = !previewOpen;
        setPreviewOpen(next);
        if (next && !preview) loadPreview(previewKind);
      };

      if (state === "loading") return jsx("div", { children: L.loading });
      if (state === "error") return jsx("div", { children: L.unavailable });

      const stView = statusLine(st);
      const currentLabel = activeCard
        ? L.cardsCurrent(activeCard.name, liveText.length)
        : (liveText !== "" ? L.cardsCurrentCustom(liveText.length) : L.cardsCurrentNone);

      return jsxs("div", {
        style: embedded ? Object.assign({}, S.root, { maxWidth: "none", padding: 24 }) : S.root,
        children: [
          // —— 标题行：标题 + 当前生效状态 ——
          jsxs("div", {
            style: S.head,
            children: [
              jsx("h2", { style: S.h2, children: L.title }),
              stView ? jsx(Tag, {
                tone: stView.tone === "ok" ? "success" : (stView.tone === "error" ? "danger" : "neutral"),
                children: stView.text
              }) : null
            ]
          }),
          jsx("div", { style: S.sub, children: L.sub }),
          stale ? note(L.staleHost, "error") : null,
          cfgKeys.length ? note(L.unknownCfgKeys(cfgKeys.map((k) => "`" + k + "`").join("、")), "error") : null,

          // —— 注入行为（即时生效） ——
          jsxs("div", {
            style: S.row,
            children: [
              jsx(Switch, {
                checked: !!cfg.enabled,
                disabled: busy,
                onChange: (next) => applyShape({ enabled: next }),
                label: L.enabled
              }),
              jsx("span", { style: S.hint, children: L.enabledHint })
            ]
          }),
          jsxs("div", {
            style: S.row,
            children: [
              jsx(SegmentedControl, {
                id: "dsh-prompt-custom-mode",
                value: cfg.mode === "replace" ? "replace" : "append",
                disabled: busy,
                label: L.mode,
                onChange: (next) => applyShape({ mode: next }),
                options: [
                  { value: "append", label: L.modeAppend },
                  { value: "replace", label: L.modeReplace }
                ]
              }),
              jsx("span", { style: S.hint, children: L.modeHint })
            ]
          }),

          // —— 提示词卡：点选切换 + 新建 ——
          jsxs("div", {
            style: S.field,
            children: [
              jsxs("div", {
                style: S.row,
                children: [
                  jsx("span", { style: S.fieldTitle, children: L.cardsTitle }),
                  jsx("span", { style: S.hint, children: L.cardsHint }),
                  !adding ? jsx(Button, {
                    variant: "ghost",
                    size: "sm",
                    icon: jsx(IconPlusOutlineRegular, {}),
                    disabled: cardsGated || cards.length >= CARDS_MAX,
                    style: { marginLeft: "auto" },
                    onClick: openAdd,
                    children: L.cardsAdd
                  }) : null,
                  !adding && cards.length >= CARDS_MAX ? jsx("span", { style: S.hint, children: L.cardsLimit }) : null
                ]
              }),
              stale ? note(L.cardsStale, "error") : null,
              cards.length > 0 ? jsxs("div", {
                style: S.row,
                children: [
                  ...cards.map((card) => jsx(Pill, {
                    key: card.id,
                    active: activeCard ? card.id === activeCard.id : false,
                    disabled: cardUiBusy,
                    title: String(card.text || "").length + " 字符",
                    onClick: () => useCard(card),
                    children: card.name
                  })),
                  !activeCard && liveText.trim() !== ""
                    ? jsx(Pill, { active: true, children: L.cardsVirtual })
                    : null
                ]
              }) : null,
              cards.length === 0 ? note(L.cardsEmpty, "muted") : null,
              jsxs("div", {
                style: S.row,
                children: [
                  jsx("span", { style: S.hint, children: currentLabel }),
                  activeCard && !pendingCard && !adding ? jsx(Button, {
                    variant: "ghost", size: "sm", disabled: cardsGated,
                    style: { marginLeft: "auto" },
                    onClick: () => openRename(activeCard),
                    children: L.cardsRename
                  }) : null,
                  activeCard && !pendingCard && !adding ? jsx(Button, {
                    variant: "ghost", size: "sm", disabled: cardsGated,
                    onClick: () => openRemove(activeCard),
                    children: L.cardsRemove
                  }) : null
                ]
              }),
              // 行内面板：新建 / 切换三选 / 改名 / 删除，同一时刻只会有一个。
              adding ? jsxs("div", {
                style: S.panel,
                children: [
                  jsx(Input, {
                    value: newName,
                    disabled: busy,
                    placeholder: L.cardsNamePlaceholder,
                    style: { width: 260 },
                    onChange: (e) => setNewName(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") submitAdd(); }
                  }),
                  jsx(Button, { variant: "primary", size: "sm", disabled: busy, onClick: submitAdd, children: L.cardsSave }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: cancelAdd, children: L.cardsCancel }),
                  jsx("span", { style: S.hint, children: L.cardsAddHint })
                ]
              }) : null,
              pending && pending.kind === "use" && pendingCard ? jsxs("div", {
                style: S.warnPanel,
                children: [
                  jsx("span", { style: S.hint, children: L.cardsUseDirty }),
                  jsx(Button, {
                    variant: "primary", size: "sm", disabled: busy,
                    onClick: activeCard ? switchSaving : switchForking,
                    children: activeCard ? L.cardsSwitchSave(activeCard.name) : L.cardsSwitchFork
                  }),
                  activeCard ? jsx(Button, {
                    variant: "ghost", size: "sm", disabled: busy,
                    onClick: switchForking,
                    children: L.cardsSwitchFork
                  }) : null,
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: switchDiscarding, children: L.cardsSwitchDiscard }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => setPending(null), children: L.cardsCancel })
                ]
              }) : null,
              pending && pending.kind === "rename" && pendingCard ? jsxs("div", {
                style: S.panel,
                children: [
                  jsx("span", { style: S.hint, children: L.cardsRenameLabel }),
                  jsx(Input, {
                    value: renameText,
                    disabled: busy,
                    style: { width: 260 },
                    onChange: (e) => setRenameText(e.target.value),
                    onKeyDown: (e) => { if (e.key === "Enter") submitRename(); }
                  }),
                  jsx(Button, { variant: "primary", size: "sm", disabled: busy, onClick: submitRename, children: L.cardsRenameSave }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => setPending(null), children: L.cardsCancel })
                ]
              }) : null,
              pending && pending.kind === "remove" && pendingCard ? jsxs("div", {
                style: S.panel,
                children: [
                  jsx("span", { style: S.hint, children: L.cardsRemoveAsk(pendingCard.name) }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: submitRemove, children: L.cardsRemoveConfirm }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => setPending(null), children: L.cardsCancel })
                ]
              }) : null,
              cardNotice ? jsx("span", { style: S.hint, children: cardNotice }) : null
            ]
          }),

          // —— 正文编辑 ——
          jsxs("div", {
            style: S.field,
            children: [
              jsx("span", { style: S.fieldTitle, children: L.text }),
              jsx("textarea", {
                value: editorText,
                rows: 12,
                spellCheck: false,
                placeholder: "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
                style: S.textarea,
                onChange: (e) => setCfg((prev) => Object.assign({}, prev, { text: e.target.value }))
              }),
              jsxs("div", {
                style: S.row,
                children: [
                  jsx(Button, { variant: "primary", disabled: busy, onClick: save, children: busy ? L.saving : saveLabel }),
                  dirtyText ? jsx(Button, { variant: "ghost", disabled: busy, onClick: revert, children: L.revert }) : null,
                  dirtyText ? jsx(Tag, { tone: "warning", children: L.dirtyTag }) : null,
                  notice ? jsx("span", { style: S.hint, children: notice }) : null
                ]
              }),
              jsx("span", { style: S.hint, children: L.textHint })
            ]
          }),

          // —— 变量告警（内核 renderPrompt 遇到未知变量会抛错，这里必须提前说） ——
          vars.malformed.length ? note(L.varMalformed(vars.malformed.map((n) => "{{" + n + "}}").join("、")), "warn") : null,
          vars.unknown.length ? note(L.varWarn(vars.unknown.map((n) => "{{" + n + "}}").join("、")), "warn") : null,

          // —— 预览（折叠一行，展开后按需拉取） ——
          jsx(DisclosureRow, {
            icon: jsx(IconChevronDownOutlineRegular, {}),
            title: L.previewTitle,
            open: previewOpen,
            expandable: true,
            // 整行可点 + 键盘可达（默认 false 只剩行首小箭头按钮，太小、难发现）。
            expandOnRowClick: true,
            onToggle: togglePreview,
            children: previewOpen ? [
              jsxs("div", {
                style: S.row,
                children: [
                  jsx(SegmentedControl, {
                    id: "dsh-prompt-custom-preview",
                    value: previewKind,
                    disabled: previewBusy,
                    label: L.previewTitle,
                    onChange: (next) => { setPreviewKind(next); loadPreview(next); },
                    options: [
                      { value: "official", label: L.previewOfficial },
                      { value: "effective", label: L.previewEffective }
                    ]
                  }),
                  jsx(Button, {
                    variant: "ghost", size: "sm", disabled: previewBusy,
                    onClick: () => loadPreview(previewKind),
                    children: previewBusy ? L.previewing : L.previewReload
                  }),
                  jsx("span", { style: S.hint, children: previewKind === "effective" ? L.previewHintEffective : L.previewHintOfficial })
                ]
              }),
              preview && preview.error
                ? note(preview.text, "error")
                : jsx("textarea", {
                    value: preview && !preview.error ? preview.text : "",
                    readOnly: true,
                    rows: 14,
                    spellCheck: false,
                    style: S.mono
                  }),
              preview && !preview.error && preview.kind === "effective" && !(st && st.injected)
                ? note(L.previewNoAgent, "muted")
                : null
            ] : null
          }),

          file ? jsx("div", { style: S.hint, children: L.storage + ": " + file }) : null
        ]
      });
    }

    const PANEL_CSS = [
      ".dsh-fuj-settings-trigger{position:absolute;right:calc(100% + 8px);top:0;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;box-sizing:border-box;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l3,#dfe2e5);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#68707b);cursor:pointer;pointer-events:auto}",
      ".dsh-fuj-settings-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,128,140,.08));color:var(--dsw-alias-label-primary,#20252b)}",
      ".dsh-fuj-settings-trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#169760);outline-offset:3px}",
      ".dsh-fuj-panel.dsh-fuj-panel{width:min(900px,100%);height:min(720px,calc(100dvh - 64px));max-height:100%;padding:0;gap:0;border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#20252b)}",
      ".dsh-fuj-panel-layout{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}",
      ".dsh-fuj-panel-header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:18px 20px 16px 24px}",
      ".dsh-fuj-panel-heading{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dsh-fuj-panel-title{margin:0;font-size:18px;line-height:26px;font-weight:600}",
      ".dsh-fuj-panel-subtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      ".dsh-fuj-panel-navigation{flex:none;padding:0 24px 16px;border-bottom:1px solid var(--dsw-alias-border-l3,#e5e7eb)}",
      ".dsh-fuj-panel-tabs{width:620px;max-width:100%}",
      ".dsh-fuj-panel-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}",
      ".dsh-fuj-skills{padding:24px;min-height:340px;box-sizing:border-box}",
      ".dsh-fuj-skills-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}",
      ".dsh-fuj-skills-heading h3{margin:0;font-size:16px;line-height:24px;font-weight:600}",
      ".dsh-fuj-skills-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      ".dsh-fuj-skills-caption{margin:8px 0 20px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      ".dsh-fuj-skill-card{display:flex;flex-direction:column;gap:18px;padding:20px;border:1px solid var(--dsw-alias-border-l3,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff)}",
      ".dsh-fuj-skill-main{display:flex;align-items:flex-start;gap:14px;min-width:0}",
      ".dsh-fuj-skill-art{display:flex;align-items:center;justify-content:center;flex:none;width:42px;height:42px;border-radius:12px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,128,140,.07));color:var(--dsw-alias-label-secondary,#68707b)}",
      ".dsh-fuj-skill-info{flex:1;min-width:0}",
      ".dsh-fuj-skill-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsh-fuj-skill-title h4{margin:0;font-size:15px;line-height:22px;font-weight:600}",
      ".dsh-fuj-skill-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      ".dsh-fuj-skill-status[data-enabled=true]{color:#169760}",
      ".dsh-fuj-skill-status[data-error=true]{color:var(--dsw-alias-label-error,#b42318)}",
      ".dsh-fuj-skill-project{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#68707b)}",
      ".dsh-fuj-skill-source{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:12px;line-height:18px}",
      ".dsh-fuj-skill-source a{color:var(--dsw-alias-label-secondary,#68707b);text-underline-offset:3px}",
      ".dsh-fuj-skill-bottom{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:15px;border-top:1px solid var(--dsw-alias-border-l3,#e5e7eb)}",
      ".dsh-fuj-skill-hint{font-size:12px;line-height:19px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      ".dsh-fuj-skill-actions{display:flex;align-items:center;gap:12px;margin-left:auto}",
      ".dsh-fuj-skill-enable{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#68707b)}",
      ".dsh-fuj-skills-error{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 16px;padding:10px 12px;border-radius:8px;background:rgba(180,35,24,.06);color:var(--dsw-alias-label-error,#b42318);font-size:12px;line-height:19px}",
      ".dsh-fuj-skill-message{margin:0;color:var(--dsw-alias-label-secondary,#68707b);font-size:12px;line-height:19px;overflow-wrap:anywhere}",
      ".dsh-fuj-skill-message[data-error=true]{color:var(--dsw-alias-label-error,#b42318)}",
      ".dsh-fuj-skill-progress{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px 12px;margin:12px 0 0}",
      ".dsh-fuj-skill-progress-track{position:relative;grid-column:1/-1;display:block;width:100%;height:6px;overflow:hidden;border:0;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#edf0f2);color:var(--dsw-alias-state-business-primary,#2788d9);appearance:none}",
      ".dsh-fuj-skill-progress-track::-webkit-progress-bar{border-radius:999px;background:var(--dsw-alias-bg-layer-3,#edf0f2)}",
      ".dsh-fuj-skill-progress-track::-webkit-progress-value{border-radius:999px;background:currentColor;transition:width 180ms ease}",
      ".dsh-fuj-skill-progress-track::-moz-progress-bar{border-radius:999px;background:currentColor}",
      ".dsh-fuj-skill-progress[data-indeterminate=true] .dsh-fuj-skill-progress-track::after{content:\"\";position:absolute;inset:0 auto 0 0;width:35%;border-radius:999px;background:currentColor;animation:dsh-fuj-progress 1.15s ease-in-out infinite alternate}",
      "@keyframes dsh-fuj-progress{from{transform:translateX(-5%)}to{transform:translateX(190%)}}",
      ".dsh-fuj-skill-progress-stage,.dsh-fuj-skill-progress-value{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#68707b)}",
      ".dsh-fuj-skill-progress-value{font-variant-numeric:tabular-nums}",
      ".dsh-fuj-skill-cancel{margin-left:auto}",
      ".dsh-fuj-skills-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;min-height:280px;text-align:center}",
      ".dsh-fuj-skills-icon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:16px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,128,140,.07));color:var(--dsw-alias-label-secondary,#68707b)}",
      ".dsh-fuj-skills-empty p{margin:0;font-size:14px;line-height:22px}",
      ".dsh-fuj-skills-empty small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a919a)}",
      "@media(max-width:600px){.dsh-fuj-panel-header{padding:16px}.dsh-fuj-panel-navigation{padding:0 16px 14px}.dsh-fuj-panel-subtitle{display:none}}"
    ].join("\n");

    const REA_CATALOG = {
      id: "rea",
      name: "逆向破解",
      projectName: "Reverse Engineer Anything (REA)",
      repositoryUrl: "https://github.com/morluto/rea",
      installUrl: "https://registry.npmjs.org/rea-agents/latest",
      installed: false,
      enabled: false,
      busy: false,
      phase: "not_installed",
      version: null,
      message: null,
      progress: null,
      tools: 0
    };

    const ABOUTSECURITY_CATALOG = {
      id: "aboutsecurity",
      name: "渗透测试",
      projectName: "WgpSec AboutSecurity",
      repositoryUrl: "https://github.com/wgpsec/AboutSecurity",
      installUrl: "https://codeload.github.com/wgpsec/AboutSecurity/zip/refs/heads/master",
      installed: false,
      enabled: false,
      busy: false,
      phase: "not_installed",
      version: null,
      skillCount: 0,
      message: null,
      progress: null,
      tools: 0
    };
    // 知识库：语料随插件分发（plugin/knowledge/），没有下载、没有安装、没有删除。
    const KNOWLEDGE_CATALOG = {
      id: "knowledge",
      name: "知识库",
      projectName: "CVE / PoC 漏洞知识库",
      repositoryUrl: null,
      installUrl: null,
      installed: true,
      enabled: false,
      busy: false,
      phase: "disabled",
      version: null,
      skillCount: null,
      entries: null,
      message: null,
      progress: null,
      tools: 0
    };

    const SKILL_CATALOG = [KNOWLEDGE_CATALOG, REA_CATALOG, ABOUTSECURITY_CATALOG];
    const SKILL_IDS = new Set(SKILL_CATALOG.map((item) => item.id));

    function SkillLibrary({ active }) {
      const [items, setItems] = react.useState([]);
      const [loading, setLoading] = react.useState(true);
      const [error, setError] = react.useState("");
      const [actionId, setActionId] = react.useState(null);
      const [refreshIndex, setRefreshIndex] = react.useState(0);
      const actionLock = react.useRef(false);
      const mounted = react.useRef(true);

      react.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
      }, []);

      const decode = async (resp) => {
        if (resp.status === 404 || resp.status === 501 || resp.status === 503) {
          throw new Error("技能库暂不可用，请更新插件并完全重启 DSH。");
        }
        let data;
        try { data = await resp.json(); } catch { throw new Error("技能库状态读取失败，请重试。"); }
        const skills = data && Array.isArray(data.skills) ? data.skills.filter((item) => item && SKILL_IDS.has(item.id)) : null;
        if (!resp.ok || !data || data.ok === false || !skills || !skills.length) {
          const failure = new Error(data && data.message ? String(data.message).slice(0, 180) : "技能库操作失败，请重试。");
          // Conflict responses can include the authoritative in-progress snapshot.
          // Keep it so the card follows the existing operation instead of its stale state.
          if (skills && skills.length) failure.skills = skills;
          throw failure;
        }
        return skills;
      };

      react.useEffect(() => {
        if (!active) return;
        let cancelled = false;
        let timer;
        const controller = new AbortController();
        const refresh = async () => {
          try {
            const resp = await fetch(SKILLS_URL, {
              headers: { accept: "application/json" },
              signal: controller.signal
            });
            const skills = await decode(resp);
            if (cancelled) return;
            setItems(skills);
            setLoading(false);
            setError("");
            if (skills.some((skill) => skill.busy)) timer = setTimeout(refresh, 1500);
          } catch (cause) {
            if (cancelled) return;
            setLoading(false);
            setError(String(cause && cause.message || "技能库状态读取失败，请重试。"));
            if (cause && cause.skills) {
              setItems(cause.skills);
              if (cause.skills.some((skill) => skill.busy)) timer = setTimeout(refresh, 1500);
            }
          }
        };
        refresh();
        return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
      }, [active, refreshIndex]);

      const act = async (skill, action) => {
        const cancelling = action === "cancel";
        if (actionLock.current || (skill.busy && !cancelling)) return;
        if (cancelling && (!skill.busy || skill.phase !== "installing" || skill.canCancel !== true)) return;
        actionLock.current = true;
        setActionId(skill.id);
        setError("");
        try {
          const resp = await fetch(SKILLS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: skill.id, action })
          });
          const skills = await decode(resp);
          if (!mounted.current) return;
          setItems(skills);
          setRefreshIndex((current) => current + 1);
        } catch (cause) {
          if (mounted.current) {
            setError(String(cause && cause.message || "技能库操作失败，请重试。"));
            if (cause && cause.skills) {
              setItems(cause.skills);
              if (cause.skills.some((item) => item.busy)) setRefreshIndex((current) => current + 1);
            }
          }
        } finally {
          actionLock.current = false;
          if (mounted.current) setActionId(null);
        }
      };

      // 知识库已经挪到独立页签，技能库这里只列需要下载的库。
      const visible = (items.length ? items : SKILL_CATALOG).filter((item) => item.id !== "knowledge");
      const phaseLabel = (skill) => {
        if (loading) return "读取中…";
        const phases = {
          not_installed: "未安装", installing: "下载中…", cancelling: "取消中…", enabling: "注入中…",
          disabling: "关闭中…", deleting: "删除中…", cancelled: "已取消", ready: "已启用", disabled: "已关闭", error: "失败"
        };
        return phases[skill.phase] || (skill.enabled ? "已启用" : skill.installed ? "已关闭" : "未安装");
      };
      const formatBytes = (value) => {
        if (value == null || value === "") return null;
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes < 0) return null;
        if (bytes < 1024) return bytes + " B";
        const units = ["KB", "MB", "GB"];
        let size = bytes / 1024;
        let unit = units[0];
        for (let i = 1; size >= 1024 && i < units.length; i++) { size /= 1024; unit = units[i]; }
        return size.toFixed(size >= 10 ? 0 : 1) + " " + unit;
      };
      const progressInfo = (skill) => {
        const progress = skill.progress && typeof skill.progress === "object" ? skill.progress : {};
        const percentValue = Number(progress.percent);
        const determinate = progress.percent != null && progress.percent !== "" && Number.isFinite(percentValue) && percentValue >= 0 && percentValue <= 100;
        const percent = determinate ? Math.round(percentValue) : null;
        const received = formatBytes(progress.receivedBytes);
        const total = formatBytes(progress.totalBytes);
        const amount = received && total ? received + " / " + total : received ? received + " 已下载" : null;
        const stages = { metadata: "连接官方来源", package: "下载 REA", archive: "下载技能库", extracting: "解压技能文件", download: "下载 REA", dependencies: "安装依赖", install: "安装依赖", registering: "注册技能与工具", cancelling: "正在取消" };
        const stage = stages[progress.stage] || (typeof progress.stage === "string" && progress.stage ? progress.stage : skill.message || "正在下载并安装");
        return { determinate, percent, amount, stage, value: determinate ? percent : undefined };
      };

      return jsxs("div", {
        className: "dsh-fuj-skills",
        children: [
          jsxs("div", {
            className: "dsh-fuj-skills-heading",
            children: [
              jsx("h3", { children: L.skillsTitle }),
              jsx("span", { className: "dsh-fuj-skills-count", children: "已安装 " + visible.filter((item) => item.installed).length + " / " + visible.length })
            ]
          }),
          jsx("p", { className: "dsh-fuj-skills-caption", children: "知识库随插件内置（CVE / PoC 语料，离线）；其余技能从官方来源下载安装。开启后即可在对话中使用。" }),
          error ? jsxs("div", {
            role: "alert",
            className: "dsh-fuj-skills-error",
            children: [
              jsx("span", { children: error }),
              jsx(Button, { variant: "ghost", size: "sm", onClick: () => setRefreshIndex((value) => value + 1), disabled: !!actionId, children: "重试" })
            ]
          }) : null,
          visible.map((skill) => {
            const busy = loading || skill.busy || actionId === skill.id;
            const unavailable = !items.length || !!error;
            return jsxs("article", {
              className: "dsh-fuj-skill-card",
              "data-skill-id": skill.id,
              "aria-busy": busy,
              children: [
                jsxs("div", {
                  className: "dsh-fuj-skill-main",
                  children: [
                    jsx("div", { className: "dsh-fuj-skill-art", "aria-hidden": true, children: jsx(IconSkillOutlineRegular, { size: 24 }) }),
                    jsxs("div", {
                      className: "dsh-fuj-skill-info",
                      children: [
                        jsxs("div", {
                          className: "dsh-fuj-skill-title",
                          children: [
                            jsx("h4", { children: skill.name || SKILL_CATALOG.find((item) => item.id === skill.id)?.name || skill.id }),
                            jsx("span", { role: "status", className: "dsh-fuj-skill-status", "data-enabled": !!skill.enabled && !skill.busy, "data-error": skill.phase === "error", children: phaseLabel(skill) })
                          ]
                        }),
                        jsx("p", { className: "dsh-fuj-skill-project", children: skill.projectName || SKILL_CATALOG.find((item) => item.id === skill.id)?.projectName || "" }),
                        jsxs("div", {
                          className: "dsh-fuj-skill-source",
                          children: skill.id === "knowledge" ? [
                            jsx("span", { className: "dsh-fuj-skill-hint", children: "随插件分发的离线语料" }),
                            skill.skillCount ? jsx("span", { className: "dsh-fuj-skill-hint", children: skill.skillCount + " 个分类" }) : null,
                            skill.entries ? jsx("span", { className: "dsh-fuj-skill-hint", children: skill.entries + " 条漏洞" }) : null
                          ] : [
                            jsx("a", { href: skill.repositoryUrl || "#", target: "_blank", rel: "noreferrer noopener", children: skill.id === "rea" ? "morluto/rea ↗" : "wgpsec/AboutSecurity ↗" }),
                            jsx("a", { href: skill.installUrl || skill.repositoryUrl || "#", target: "_blank", rel: "noreferrer noopener", children: "最新版下载链接 ↗" }),
                            skill.version ? jsx("span", { className: "dsh-fuj-skill-hint", children: "v" + skill.version }) : null,
                            skill.skillCount ? jsx("span", { className: "dsh-fuj-skill-hint", children: skill.skillCount + " 个技能" }) : null
                          ]
                        })
                      ]
                    })
                  ]
                }),
                skill.message && !(skill.busy && ["installing", "cancelling"].includes(skill.phase)) ? jsx("p", { role: skill.phase === "error" ? "alert" : "status", className: "dsh-fuj-skill-message", "data-error": skill.phase === "error", children: String(skill.message).slice(0, 240) }) : null,
                skill.busy && ["installing", "cancelling"].includes(skill.phase) ? (() => {
                  const progress = progressInfo(skill);
                  const label = [progress.stage, progress.amount].filter(Boolean).join(" · ");
                  return jsxs("div", {
                    className: "dsh-fuj-skill-progress",
                    "data-indeterminate": !progress.determinate,
                    role: "group",
                    "aria-label": (skill.projectName || skill.name || "技能") + "下载进度",
                    children: [
                      jsx("progress", { className: "dsh-fuj-skill-progress-track", max: 100, value: progress.value, "aria-label": "下载安装进度" }),
                      jsx("span", { className: "dsh-fuj-skill-progress-stage", children: label || progress.stage }),
                      jsx("span", { className: "dsh-fuj-skill-progress-value", children: progress.percent === null ? "处理中…" : progress.percent + "%" })
                    ]
                  });
                })() : null,
                jsxs("div", {
                  className: "dsh-fuj-skill-bottom",
                  children: [
                    jsx("span", {
                      className: "dsh-fuj-skill-hint",
                      children: skill.busy ? "操作完成后会自动更新状态。"
                        : skill.id === "knowledge"
                          ? (skill.enabled ? "已注入：模型可从 skills 目录直接调用这些分类。" : "内置语料：开启后模型即可在 skills 目录里看到并调用。")
                          : skill.enabled ? "已注入，可在对话中使用。" : skill.installed ? "开启后注入，关闭时保留下载文件。" : "从官方来源下载并自动安装。"
                    }),
                    skill.busy && skill.phase === "installing" && skill.canCancel === true ? jsx(Button, {
                      variant: "ghost", size: "sm", className: "dsh-fuj-skill-cancel",
                      disabled: actionId === skill.id,
                      onClick: () => act(skill, "cancel"),
                      children: actionId === skill.id ? "正在取消…" : "取消下载"
                    }) : skill.installed ? jsxs("div", {
                      className: "dsh-fuj-skill-actions",
                      children: [
                        jsxs("div", {
                          className: "dsh-fuj-skill-enable",
                          children: [
                            jsx("span", { children: skill.enabled ? "已开启" : "已关闭" }),
                            jsx(Switch, { label: "启用" + (skill.name || "技能"), checked: !!skill.enabled, disabled: busy || unavailable, onChange: (next) => act(skill, next ? "enable" : "disable") })
                          ]
                        }),
                        skill.id === "knowledge" ? null : jsx(Button, { variant: "ghost", size: "sm", disabled: busy || unavailable, onClick: () => act(skill, "delete"), children: "删除" })
                      ]
                    }) : jsx(Button, {
                      variant: "primary", size: "sm", disabled: busy || unavailable,
                      onClick: () => act(skill, "install"), children: skill.busy ? phaseLabel(skill) : "下载安装"
                    })
                  ]
                })
              ]
            }, skill.id);
          })
        ]
      });
    }

    const STAGE_LABEL = { recon: "信息收集", fingerprint: "指纹识别", match: "漏洞匹配", verify: "可行性验证", exploit: "漏洞利用", lateral: "横向移动", report: "报告输出" };
    const STAGE_ORDER = ["recon", "fingerprint", "match", "verify", "exploit", "lateral", "report"];

    function CampaignPanel({ active, sessionIdHint }) {
      const [data, setData] = react.useState(null);
      const [detail, setDetail] = react.useState(null);
      const [creating, setCreating] = react.useState(false);
      const [draftName, setDraftName] = react.useState("");
      const [draftScope, setDraftScope] = react.useState("");
      const [confirmDelete, setConfirmDelete] = react.useState("");
      const [notice, setNotice] = react.useState("");
      const [sessions, setSessions] = react.useState([]);
      const [pick, setPick] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");

      // 尽最大努力识别"当前对话"：扫 localStorage 里含 session 的键，取第一个 session-<uuid>。
      const guessSession = () => {
        if (sessionIdHint) return sessionIdHint;
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i) || "";
            if (!/session/i.test(key)) continue;
            const raw = localStorage.getItem(key) || "";
            const hit = /session-[0-9a-f-]{36}/i.exec(raw);
            if (hit) return hit[0];
          }
        } catch (_) { /* ignore */ }
        return "";
      };

      const loadSessions = react.useCallback(async () => {
        try {
          const resp = await fetch(SESSIONS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          const list = Array.isArray(json && json.sessions) ? json.sessions : [];
          setSessions(list);
          setPick((prev) => prev || (list.some((x) => x.id === guessSession()) ? guessSession() : (list[0] && list[0].id) || ""));
        } catch (_) { /* ignore */ }
      }, []);
      const load = react.useCallback(async () => {
        try {
          const resp = await fetch(CAMPAIGNS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setData(json);
          setError("");
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      const open = react.useCallback(async (id) => {
        try {
          const resp = await fetch(CAMPAIGNS_URL + "?id=" + encodeURIComponent(id), { headers: { accept: "application/json" } });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setDetail(json);
          setError("");
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      react.useEffect(() => { if (active) { load(); loadSessions(); } }, [active, load, loadSessions]);

      const post = async (body) => {
        setBusy(true); setError("");
        try {
          const resp = await fetch(CAMPAIGNS_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "x-dsh-ui": "1" },
            body: JSON.stringify(body)
          });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setNotice(json.kicked === true ? L.taskKicked : (json.kickReason ? L.taskKickHint + json.kickReason : ""));
          await load();
          if (body.id && body.action !== "delete") await open(body.id);
          if (body.action === "delete") setDetail(null);
          return true;
        } catch (e) { setError(String((e && e.message) || e)); return false; }
        finally { setBusy(false); }
      };

      const submitCreate = async () => {
        const name = draftName.trim();
        if (!name) return;
        const domains = draftScope.split(/[\s,，;]+/).map((x) => x.trim()).filter(Boolean);
        if (await post({ action: "create", name, scope: { domains } })) {
          setCreating(false); setDraftName(""); setDraftScope("");
        }
      };
      const stageBar = (current) => {
        const index = STAGE_ORDER.indexOf(current);
        return jsxs("div", {
          style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", padding: "2px 0" },
          children: [
            jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: L.taskProgress }),
            ...STAGE_ORDER.map((key, i) => {
              const done = i < index;
              const now = i === index;
              const color = now ? "#175cd3" : (done ? "#169760" : "var(--dsw-alias-label-tertiary)");
              const bg = now ? "rgba(23,92,211,.10)" : (done ? "rgba(22,151,96,.10)" : "transparent");
              return jsxs("span", {
                key,
                style: {
                  display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999,
                  fontSize: 12, lineHeight: "20px", color, background: bg,
                  border: "1px solid " + (now ? "#175cd3" : (done ? "#169760" : "var(--dsw-alias-border-l3)")),
                  fontWeight: now ? 600 : 400
                },
                children: [(done ? "✓ " : (i + 1) + " ") + (STAGE_LABEL[key] || key)]
              }, key);
            })
          ]
        });
      };
      const items = data && Array.isArray(data.items) ? data.items : [];
      const current = detail && detail.campaign ? detail.campaign : null;
      const next = detail && detail.next ? detail.next : null;

      return jsxs("div", {
        className: "dsh-fuj-skills",
        children: [
          jsxs("div", {
            className: "dsh-fuj-skills-heading",
            children: [
              jsx("h3", { children: L.taskTitle }),
              jsx(Button, { variant: "primary", size: "sm", disabled: busy || creating, onClick: () => setCreating(true), children: L.taskNew })
            ]
          }),
          error ? jsxs("div", {
            role: "alert",
            className: "dsh-fuj-skills-error",
            children: [jsx("span", { children: error }), jsx(Button, { variant: "ghost", size: "sm", onClick: load, disabled: busy, children: "重试" })]
          }) : null,
          creating ? jsxs("article", {
            className: "dsh-fuj-skill-card",
            style: { gap: 10, marginBottom: 10 },
            children: [
              jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: L.taskCreateHint }),
              jsx(Input, {
                value: draftName,
                placeholder: L.taskNamePlaceholder,
                onChange: (e) => setDraftName(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter") submitCreate(); }
              }),
              jsx(Input, {
                value: draftScope,
                placeholder: L.taskScopePlaceholder,
                onChange: (e) => setDraftScope(e.target.value)
              }),
              jsxs("div", {
                style: { display: "flex", gap: 8 },
                children: [
                  jsx(Button, { variant: "primary", size: "sm", disabled: busy || !draftName.trim(), onClick: submitCreate, children: L.taskCreate }),
                  jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => { setCreating(false); setDraftName(""); setDraftScope(""); }, children: L.taskCancel })
                ]
              })
            ]
          }) : null,          ...items.map((item) => {
            const expanded = current && current.id === item.id;
            return jsxs("article", {
              className: "dsh-fuj-skill-card",
              style: { gap: 10, marginBottom: 10 },
              children: [
                jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" },
                  onClick: () => (expanded ? setDetail(null) : open(item.id)),
                  children: [
                    jsx("span", {
                      style: { flex: "0 0 auto", padding: "1px 8px", borderRadius: 999, fontSize: 12, lineHeight: "20px", color: "#175cd3", background: "rgba(23,92,211,.08)", border: "1px solid #175cd3" },
                      children: STAGE_LABEL[item.stage] || item.stage
                    }),
                    jsxs("div", { style: { minWidth: 0, flex: 1 }, children: [
                      jsx("div", { style: { fontSize: 14, lineHeight: "22px", overflowWrap: "anywhere" }, children: item.name }),
                      jsx("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" }, children: L.taskAssets + " " + item.assets + " · " + L.taskSteps + " " + item.steps + " · " + fmtTime(item.updatedAt) })
                    ]})
                  ]
                }),
                expanded && current ? jsxs("div", {
                  style: { borderTop: "1px solid var(--dsw-alias-border-l3)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 },
                  children: [
                    jsx("div", { style: { fontSize: 13, lineHeight: "20px", fontWeight: 600 }, children: (current.done ? "✓ 已达成 · " : "") + L.taskObjective + (current.objective || current.name) }),
                    stageBar(current.stage),
                    notice ? jsx("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-secondary)" }, children: notice }) : null,
                    current.sessionId
                      ? jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" }, children: L.taskBound + current.sessionId })
                      : jsxs("div", {
                          style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
                          children: [
                            jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: L.taskBindPick }),
                            jsx("select", {
                              value: pick,
                              onChange: (e) => setPick(e.target.value),
                              style: { height: 28, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-bg-layer-2)", color: "inherit", fontSize: 12, maxWidth: 260 }
                            }, sessions.length
                              ? sessions.map((x, i) => jsx("option", { value: x.id, title: x.id, children: (x.id === guessSession() ? "★ " : "") + (x.title ? x.title.slice(0, 24) : "对话 " + (i + 1)) + " · " + x.id.slice(-8) + (x.status === "running" ? "（运行中）" : "") }, x.id))
                              : jsx("option", { value: "", children: "没有在线对话" })),
                            jsx(Button, { variant: "ghost", size: "sm", disabled: busy || !pick, onClick: () => post({ action: "bind", id: current.id, sessionId: pick }), children: L.taskBind }),
                            jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: loadSessions, children: "刷新" })
                          ]
                        }),
                    jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" }, children: L.taskScope + "：" + ([current.scope.domains, current.scope.cidrs].flat().filter(Boolean).join(" · ") || "-") }),
                    sessionIdHint ? jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" }, children: "面板识别到的对话：" + sessionIdHint }) : null,
                    jsx("div", { style: { fontSize: 12, lineHeight: "18px" }, children: current.assets.length ? current.assets.map((a) => a.host + (a.port ? ":" + a.port : "") + (a.fingerprint ? "（" + a.fingerprint + "）" : "") + " · " + (a.status || "new")).join("\n") : L.taskNoAdvice }),
                    jsx("div", { style: { fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap" }, children: current.steps.length ? current.steps.slice(-5).map((st) => "[" + (STAGE_LABEL[st.stage] || st.stage) + "] " + st.action + " → " + st.result).join("\n") : "" }),
                    jsxs("div", {
                      style: { padding: 10, borderRadius: 8, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l3)" },
                      children: [
                        jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", marginBottom: 4 }, children: L.taskSuggest }),
                        jsx("div", { style: { fontSize: 12, lineHeight: "19px", whiteSpace: "pre-wrap" }, children: next && (next.suggestions || []).length ? next.suggestions.map((sg) => sg.text).join("\n") : L.taskNoAdvice })
                      ]
                    }),
                    jsxs("div", {
                      style: { display: "flex", gap: 8, flexWrap: "wrap" },
                      children: [
                        current.sessionId ? jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => post({ action: "kick", id: current.id }), children: L.taskKick }) : null,
                        current.sessionId ? jsx(Button, { variant: "ghost", size: "sm", disabled: busy, onClick: () => post({ action: "unbind", id: current.id }), children: L.taskUnbind }) : null,
                        jsx(Button, {
                          variant: "ghost", size: "sm",
                          disabled: busy || STAGE_ORDER.indexOf(current.stage) <= 0,
                          onClick: () => post({ action: "patch", id: current.id, stage: STAGE_ORDER[STAGE_ORDER.indexOf(current.stage) - 1] }),
                          children: L.taskPrev
                        }),
                        jsx(Button, {
                          variant: "primary", size: "sm", disabled: busy || !next || (next && next.nextStage === current.stage),
                          onClick: () => next && post({ action: "patch", id: current.id, stage: next.nextStage }),
                          children: L.taskNext + (next ? "（" + (STAGE_LABEL[next.nextStage] || next.nextStage) + "）" : "")
                        }),
                        jsx(Button, {
                          variant: "ghost", size: "sm", style: { marginLeft: "auto" }, disabled: busy,
                          onClick: () => {
                            if (confirmDelete !== current.id) { setConfirmDelete(current.id); setTimeout(() => setConfirmDelete(""), 4000); return; }
                            setConfirmDelete(""); post({ action: "delete", id: current.id });
                          },
                          children: confirmDelete === current.id ? "确认删除？" : L.taskDelete
                        })
                      ]
                    })
                  ]
                }) : null
              ]
            }, item.id);
          }),
          data && items.length === 0 ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.taskEmpty }) }) : null,
          !data && !error ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.taskLoading }) }) : null
        ]
      });
    }
    const SEVERITY_META = {
      critical: { label: "严重", color: "#b42318", bg: "rgba(180,35,24,.08)" },
      high: { label: "高危", color: "#d92d20", bg: "rgba(217,45,32,.08)" },
      medium: { label: "中危", color: "#b54708", bg: "rgba(181,71,8,.08)" },
      low: { label: "低危", color: "#175cd3", bg: "rgba(23,92,211,.08)" },
      info: { label: "信息", color: "#475467", bg: "rgba(71,84,103,.08)" }
    };
    const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
    const STATUS_LABEL = { open: L.reportStatusOpen, fixed: L.reportStatusFixed, accepted: L.reportStatusAccepted, "false-positive": L.reportStatusFalse };

    function fmtTime(value) {
      const date = new Date(value);
      if (!value || Number.isNaN(date.getTime())) return String(value || "");
      const pad = (n) => (n < 10 ? "0" + n : String(n));
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    function ReportPanel({ active }) {
      const [data, setData] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const [filter, setFilter] = react.useState("");
      const [query, setQuery] = react.useState("");
      const [expanded, setExpanded] = react.useState("");
      const [hintOpen, setHintOpen] = react.useState(false);
      const [confirmClear, setConfirmClear] = react.useState(false);

      // 尽最大努力识别"当前对话"：扫 localStorage 里含 session 的键，取第一个 session-<uuid>。
      const guessSession = () => {
        if (sessionIdHint) return sessionIdHint;
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i) || "";
            if (!/session/i.test(key)) continue;
            const raw = localStorage.getItem(key) || "";
            const hit = /session-[0-9a-f-]{36}/i.exec(raw);
            if (hit) return hit[0];
          }
        } catch (_) { /* ignore */ }
        return "";
      };

      const loadSessions = react.useCallback(async () => {
        try {
          const resp = await fetch(SESSIONS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          const list = Array.isArray(json && json.sessions) ? json.sessions : [];
          setSessions(list);
          setPick((prev) => prev || (list.some((x) => x.id === guessSession()) ? guessSession() : (list[0] && list[0].id) || ""));
        } catch (_) { /* ignore */ }
      }, []);
      const load = react.useCallback(async () => {
        try {
          const resp = await fetch(FINDINGS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setData(json);
          setError("");
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      react.useEffect(() => { if (active) { load(); loadSessions(); } }, [active, load, loadSessions]);

      const post = async (body) => {
        setBusy(true); setError("");
        try {
          const resp = await fetch(FINDINGS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setData(json);
        } catch (e) { setError(String((e && e.message) || e)); }
        finally { setBusy(false); }
      };

      const exportMarkdown = async () => {
        try {
          const resp = await fetch(FINDINGS_MD_URL, { headers: { accept: "text/markdown" } });
          const text = await resp.text();
          const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = "vuln-report.md";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch (e) { setError(String((e && e.message) || e)); }
      };

      const stats = (data && data.stats) || { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0, open: 0 };
      const all = data && Array.isArray(data.items) ? data.items : [];
      const keyword = query.trim().toLowerCase();
      const matched = all.filter((item) => {
        if (filter && item.severity !== filter) return false;
        if (!keyword) return true;
        return [item.title, item.target, item.url, item.cve, item.category].filter(Boolean).join(" ").toLowerCase().includes(keyword);
      });
      const groups = SEVERITY_ORDER
        .map((severity) => ({ severity, items: matched.filter((item) => item.severity === severity) }))
        .filter((group) => group.items.length > 0);

      const metricTile = (severity) => {
        const meta = severity ? SEVERITY_META[severity] : null;
        const count = severity ? (stats[severity] || 0) : stats.total;
        const selected = filter === severity;
        return jsx("div", {
          key: severity || "all",
          onClick: () => setFilter(selected ? "" : severity),
          style: {
            flex: "1 1 0", minWidth: 104, cursor: "pointer", padding: "10px 12px", borderRadius: 10,
            border: "1px solid " + (selected ? (meta ? meta.color : "var(--dsw-alias-state-business-primary)") : "var(--dsw-alias-border-l3)"),
            borderLeft: "3px solid " + (meta ? meta.color : "var(--dsw-alias-label-tertiary)"),
            background: selected ? (meta ? meta.bg : "var(--dsw-alias-bg-layer-3)") : "var(--dsw-alias-bg-layer-2)"
          },
          children: [
            jsx("div", { style: { fontSize: 22, lineHeight: "26px", fontWeight: 600, color: meta ? meta.color : "var(--dsw-alias-label-primary)" }, children: String(count) }),
            jsx("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)" }, children: (meta ? meta.label : L.reportAll) })
          ]
        }, severity || "all");
      };

      const detailOf = (item) => jsxs("div", {
        style: { padding: "12px 14px", background: "var(--dsw-alias-bg-layer-2)", borderTop: "1px solid var(--dsw-alias-border-l3)", display: "flex", flexDirection: "column", gap: 10 },
        children: [
          item.description ? jsxs("div", { children: [
            jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 }, children: L.reportDetailDescription }),
            jsx("div", { style: { fontSize: 13, lineHeight: "21px", whiteSpace: "pre-wrap" }, children: item.description })
          ]}) : null,
          item.evidence ? jsxs("div", { children: [
            jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 }, children: L.reportDetailEvidence }),
            jsx("pre", {
              style: { margin: 0, padding: "8px 10px", borderRadius: 8, background: "var(--dsw-alias-bg-layer-3)", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 240, overflow: "auto" },
              children: item.evidence
            })
          ]}) : null,
          item.remediation ? jsxs("div", { children: [
            jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 }, children: L.reportDetailRemediation }),
            jsx("div", { style: { fontSize: 13, lineHeight: "21px", whiteSpace: "pre-wrap" }, children: item.remediation })
          ]}) : null,
          item.references ? jsxs("div", { children: [
            jsx("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", marginBottom: 2 }, children: L.reportDetailRefs }),
            jsx("div", { style: { fontSize: 12, lineHeight: "19px", overflowWrap: "anywhere" }, children: item.references })
          ]}) : null,
          jsxs("div", {
            style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: 4 },
            children: [
              jsx("span", {
                style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
                children: [item.cve, item.cvss !== null ? L.reportCvss + " " + item.cvss : "", item.verified ? L.reportVerify : L.reportUnverified, L.reportSource + " " + item.source].filter(Boolean).join(" · ")
              }),
              jsx(Button, { variant: "ghost", size: "sm", disabled: busy || item.status === "fixed", onClick: () => post({ action: "status", id: item.id, status: "fixed" }), children: L.reportStatusFixed }),
              jsx(Button, { variant: "ghost", size: "sm", disabled: busy || item.status === "accepted", onClick: () => post({ action: "status", id: item.id, status: "accepted" }), children: L.reportStatusAccepted }),
              jsx(Button, { variant: "ghost", size: "sm", disabled: busy || item.status === "false-positive", onClick: () => post({ action: "status", id: item.id, status: "false-positive" }), children: L.reportStatusFalse }),
              jsx(Button, { variant: "ghost", size: "sm", style: { marginLeft: "auto" }, disabled: busy, onClick: () => post({ action: "delete", id: item.id }), children: L.reportDelete })
            ]
          })
        ]
      });

      return jsxs("div", {
        className: "dsh-fuj-skills",
        children: [
          jsxs("div", {
            className: "dsh-fuj-skills-heading",
            style: { alignItems: "baseline" },
            children: [
              jsx("h3", { children: L.reportTitle }),
              jsx("span", { className: "dsh-fuj-skills-count", children: L.reportTotal(stats.total, stats.open || 0) + (data && data.updatedAt > 0 ? " · " + L.reportUpdated(fmtTime(new Date(data.updatedAt).toISOString())) : "") })
            ]
          }),
          jsx("p", { className: "dsh-fuj-skills-caption", children: L.reportSub }),
          jsx("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }, children: ["", ...SEVERITY_ORDER].map(metricTile) }),
          jsxs("div", {
            style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 },
            children: [
              jsx(Input, { value: query, placeholder: L.reportSearchPlaceholder, style: { flex: "1 1 220px", minWidth: 180 }, onChange: (e) => setQuery(e.target.value) }),
              jsx(Button, { variant: "ghost", size: "sm", disabled: busy || !stats.total, onClick: exportMarkdown, children: L.reportExport }),
              jsx(Button, {
                variant: "ghost", size: "sm", disabled: busy || !stats.total,
                onClick: () => { if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 4000); return; } setConfirmClear(false); post({ action: "clear" }); },
                children: confirmClear ? "确认清空？" : L.reportClear
              })
            ]
          }),
          error ? jsxs("div", {
            role: "alert",
            className: "dsh-fuj-skills-error",
            style: { marginTop: 8 },
            children: [
              jsx("span", { children: error }),
              jsx(Button, { variant: "ghost", size: "sm", onClick: load, disabled: busy, children: "重试" })
            ]
          }) : null,
          ...groups.map((group) => {
            const meta = SEVERITY_META[group.severity];
            return jsxs("div", {
              style: { marginTop: 14 },
              children: [
                jsxs("div", {
                  style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 2px 8px" },
                  children: [
                    jsx("span", { style: { width: 8, height: 8, borderRadius: 999, background: meta.color, display: "inline-block" } }),
                    jsx("span", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }, children: meta.label }),
                    jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }, children: "（" + group.items.length + "）" })
                  ]
                }),
                jsx("div", {
                  style: { border: "1px solid var(--dsw-alias-border-l3)", borderRadius: 10, overflow: "hidden", background: "var(--dsw-alias-bg-layer-2)" },
                  children: group.items.map((item, index) => {
                    const open = expanded === item.id;
                    return jsxs("div", {
                      children: [
                        jsxs("div", {
                          onClick: () => setExpanded(open ? "" : item.id),
                          style: {
                            display: "grid", gridTemplateColumns: "minmax(0, 1fr) 108px 96px", gap: 12, alignItems: "center",
                            padding: "9px 14px", cursor: "pointer",
                            borderTop: index === 0 ? "none" : "1px solid var(--dsw-alias-border-l4)",
                            background: open ? "var(--dsw-alias-bg-layer-3)" : "transparent"
                          },
                          children: [
                            jsxs("div", {
                              style: { minWidth: 0 },
                              children: [
                                jsx("div", { style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere" }, children: item.title }),
                                jsx("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" }, children: [item.target, item.url, item.cve].filter(Boolean).join(" · ") || item.foundAt })
                              ]
                            }),
                            jsx("span", { style: { fontSize: 12, color: item.status === "fixed" ? "#169760" : "var(--dsw-alias-label-secondary)" }, children: STATUS_LABEL[item.status] || item.status }),
                            jsx("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", textAlign: "right" }, children: fmtTime(item.foundAt) })
                          ]
                        }),
                        open ? detailOf(item) : null
                      ]
                    }, item.id);
                  })
                })
              ]
            }, group.severity);
          }),
          !data && !error ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.reportLoading }) }) : null,
          data && stats.total === 0 ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.reportEmpty }) }) : null,
          data && stats.total > 0 && matched.length === 0 ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.reportNoMatch }) }) : null,
          jsx(DisclosureRow, {
            icon: jsx(IconChevronDownOutlineRegular, {}),
            title: L.reportAiHint,
            open: hintOpen,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => setHintOpen(!hintOpen),
            children: hintOpen ? jsx("pre", {
              style: { margin: 0, padding: 10, borderRadius: 8, background: "var(--dsw-alias-bg-layer-2)", border: "1px solid var(--dsw-alias-border-l3)", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
              children: [
                "curl -s -X POST " + (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:54429") + "/api/dsh-prompt-custom/findings \\",
                "  -H 'content-type: application/json' \\",
                "  -d '{\"action\":\"upsert\",\"title\":\"SQL 注入\",\"severity\":\"high\",\"target\":\"api.example.com\",\"url\":\"/api/order?id=1\",\"evidence\":\"1' AND SLEEP(3)-- 延迟 3s\",\"remediation\":\"参数化查询\"}'"
              ].join("\n")
            }) : null
          })
        ]
      });
    }
    function KnowledgePanel({ active }) {
      const [data, setData] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState("");
      const [open, setOpen] = react.useState("");

      // 尽最大努力识别"当前对话"：扫 localStorage 里含 session 的键，取第一个 session-<uuid>。
      const guessSession = () => {
        if (sessionIdHint) return sessionIdHint;
        try {
          for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i) || "";
            if (!/session/i.test(key)) continue;
            const raw = localStorage.getItem(key) || "";
            const hit = /session-[0-9a-f-]{36}/i.exec(raw);
            if (hit) return hit[0];
          }
        } catch (_) { /* ignore */ }
        return "";
      };

      const loadSessions = react.useCallback(async () => {
        try {
          const resp = await fetch(SESSIONS_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          const list = Array.isArray(json && json.sessions) ? json.sessions : [];
          setSessions(list);
          setPick((prev) => prev || (list.some((x) => x.id === guessSession()) ? guessSession() : (list[0] && list[0].id) || ""));
        } catch (_) { /* ignore */ }
      }, []);
      const load = react.useCallback(async () => {
        try {
          const resp = await fetch(KNOWLEDGE_URL, { headers: { accept: "application/json" } });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          setData(json);
          setError("");
        } catch (e) { setError(String((e && e.message) || e)); }
      }, []);

      react.useEffect(() => { if (active) { load(); loadSessions(); } }, [active, load, loadSessions]);

      const toggle = async (next) => {
        if (busy) return;
        setBusy(true); setError("");
        try {
          const resp = await fetch(SKILLS_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "knowledge", action: next ? "enable" : "disable" })
          });
          const json = await resp.json();
          if (!resp.ok || !json || json.ok === false) throw new Error((json && json.message) || ("HTTP " + resp.status));
          await load();
        } catch (e) { setError(String((e && e.message) || e)); }
        finally { setBusy(false); }
      };

      const categories = data && Array.isArray(data.categories) ? data.categories : [];
      const total = data && typeof data.total === "number" ? data.total : 0;
      const enabled = !!(data && data.enabled);

      return jsxs("div", {
        className: "dsh-fuj-skills",
        children: [
          jsxs("div", {
            className: "dsh-fuj-skills-heading",
            children: [
              jsx("h3", { children: L.knowledgeTitle }),
              jsx("span", { className: "dsh-fuj-skills-count", children: enabled ? L.knowledgeTotal(total, categories.length) : "已关闭（" + (data && data.available ? data.available : 0) + " 条可用）" })
            ]
          }),
          jsx("p", { className: "dsh-fuj-skills-caption", children: L.knowledgeHint }),
          error ? jsxs("div", {
            role: "alert",
            className: "dsh-fuj-skills-error",
            children: [
              jsx("span", { children: error }),
              jsx(Button, { variant: "ghost", size: "sm", onClick: load, disabled: busy, children: "重试" })
            ]
          }) : null,
          jsx("article", {
            className: "dsh-fuj-skill-card",
            children: jsxs("div", {
              className: "dsh-fuj-skill-bottom",
              style: { paddingTop: 0, borderTop: "none" },
              children: [
                jsx("span", { className: "dsh-fuj-skill-hint", children: enabled ? L.knowledgeOn : L.knowledgeOff }),
                jsxs("div", {
                  className: "dsh-fuj-skill-enable",
                  children: [
                    jsx("span", { children: enabled ? "已开启" : "已关闭" }),
                    jsx(Switch, { label: L.knowledgeTitle, checked: enabled, disabled: busy || !data, onChange: toggle })
                  ]
                })
              ]
            })
          }),
          ...categories.map((category) => jsx(DisclosureRow, {
            key: category.name,
            icon: jsx(IconChevronDownOutlineRegular, {}),
            title: category.title + "（" + category.count + " 条）",
            open: open === category.name,
            expandable: true,
            expandOnRowClick: true,
            onToggle: () => setOpen(open === category.name ? "" : category.name),
            children: (category.entries || []).map((entry) => jsxs("div", {
              key: entry.file,
              style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 10, padding: "5px 0" },
              children: [
                jsxs("div", {
                  style: { minWidth: 0 },
                  children: [
                    jsx("div", { style: { fontSize: 13, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: entry.title }),
                    jsx("div", { style: { fontSize: 12, lineHeight: "18px", color: "var(--dsw-alias-label-tertiary)", overflowWrap: "anywhere" }, children: entry.entry || entry.file })
                  ]
                }),
                jsx("span", { style: { fontSize: 12, lineHeight: "20px", color: "var(--dsw-alias-label-secondary)" }, children: entry.severity })
              ]
            }))
          }, category.name)),
          !data && !error ? jsx("div", { className: "dsh-fuj-skills-empty", children: jsx("p", { children: L.knowledgeLoading }) }) : null,
          data && categories.length === 0 ? jsxs("div", {
            className: "dsh-fuj-skills-empty",
            children: [jsx("p", { children: L.knowledgeEmpty }), jsx("small", { children: L.knowledgeRestart })]
          }) : null
        ]
      });
    }
    function PluginPanel({ open, onClose, id, sessionId = "" }) {
      const [tab, setTab] = react.useState("prompt");
      const tabId = react.useId();
      const promptTabId = tabId + "-prompt-tab";
      const skillsTabId = tabId + "-skills-tab";
      const promptPanelId = tabId + "-prompt-panel";
      const skillsPanelId = tabId + "-skills-panel";
      const reportTabId = tabId + "-report-tab";
      const reportPanelId = tabId + "-report-panel";
      const knowledgeTabId = tabId + "-knowledge-tab";
      const knowledgePanelId = tabId + "-knowledge-panel";
      const campaignTabId = tabId + "-campaign-tab";
      const campaignPanelId = tabId + "-campaign-panel";

      return jsx(Modal, {
        open,
        onClose,
        title: L.pluginSettings,
        headless: true,
        className: "dsh-fuj-panel",
        children: jsxs("div", {
          id,
          className: "dsh-fuj-panel-layout",
          onClick: (event) => event.stopPropagation(),
          children: [
            jsxs("header", {
              className: "dsh-fuj-panel-header",
              children: [
                jsxs("div", {
                  className: "dsh-fuj-panel-heading",
                  children: [
                    jsx("h2", { className: "dsh-fuj-panel-title", children: L.toggleLabel }),
                    jsx("span", { className: "dsh-fuj-panel-subtitle", children: L.pluginSettingsHint })
                  ]
                }),
                jsx(Button, {
                  variant: "ghost",
                  size: "sm",
                  "aria-label": L.closeSettings,
                  title: L.closeSettings,
                  onClick: onClose,
                  icon: jsx(IconCloseOutlineRegular, { size: 16 })
                })
              ]
            }),
            jsx("nav", {
              className: "dsh-fuj-panel-navigation",
              "aria-label": L.pluginFunctions,
              children: jsx(SegmentedTabs, {
                className: "dsh-fuj-panel-tabs",
                label: L.pluginFunctions,
                value: tab,
                onChange: setTab,
                items: [
                  { value: "prompt", label: L.title, id: promptTabId, panelId: promptPanelId },
                  { value: "skills", label: L.skillsTitle, id: skillsTabId, panelId: skillsPanelId },
                  { value: "knowledge", label: L.knowledgeTitle, id: knowledgeTabId, panelId: knowledgePanelId },
                  { value: "report", label: L.reportTitle, id: reportTabId, panelId: reportPanelId },
                  { value: "campaign", label: L.taskTitle, id: campaignTabId, panelId: campaignPanelId }
                ]
              })
            }),
            jsxs("div", {
              className: "dsh-fuj-panel-content",
              children: [
                // Keep the editor mounted while switching tabs so unsaved edits stay intact.
                jsx("section", {
                  id: reportPanelId,
                  role: "tabpanel",
                  "aria-labelledby": reportTabId,
                  hidden: tab !== "report",
                  children: jsx(ReportPanel, { active: open && tab === "report" })
                }),
                jsx("section", {
                  id: promptPanelId,
                  role: "tabpanel",
                  "aria-labelledby": promptTabId,
                  hidden: tab !== "prompt",
                  children: jsx(Card, { embedded: true })
                }),
                jsx("section", {
                  id: skillsPanelId,
                  role: "tabpanel",
                  "aria-labelledby": skillsTabId,
                  hidden: tab !== "skills",
                  children: jsx(SkillLibrary, { active: open && tab === "skills" })
                }),
                jsx("section", {
                  id: campaignPanelId,
                  role: "tabpanel",
                  "aria-labelledby": campaignTabId,
                  hidden: tab !== "campaign",
                  children: jsx(CampaignPanel, { active: open && tab === "campaign", sessionIdHint: (sessionId || "") })
                }),
                jsx("section", {
                  id: knowledgePanelId,
                  role: "tabpanel",
                  "aria-labelledby": knowledgeTabId,
                  hidden: tab !== "knowledge",
                  children: jsx(KnowledgePanel, { active: open && tab === "knowledge" })
                })
              ]
            })
          ]
        })
      });
    }
    function apply(ctx) {
      // 启动免责声明：每次打开 Harness 弹一次；同意后本次运行不再出现，拒绝则关闭应用。
      function DisclaimerGate() {
        const KEY = "dsh-prompt-custom-disclaimer-v1";
        const [open, setOpen] = react.useState(() => {
          try { return window.sessionStorage.getItem(KEY) !== "accepted"; } catch (error) { return true; }
        });
        const accept = () => {
          try { window.sessionStorage.setItem(KEY, "accepted"); } catch (error) {}
          setOpen(false);
        };
        const refuse = () => {
          try {
            const request = fetch("/api/dsh-prompt-custom/shutdown", {
              method: "POST",
              headers: { "content-type": "application/json", "x-dsh-ui": "1" },
              body: "{}"
            });
            if (request && typeof request.catch === "function") request.catch(() => {});
          } catch (error) {}
          setTimeout(() => { try { window.close(); } catch (error) {} }, 400);
        };
        const bullet = (text) => jsx("li", { style: { margin: "0 0 6px", lineHeight: "20px" }, children: text });
        const root = jsx("div", {
          style: {
            position: "fixed",
            inset: 0,
            zIndex: 2147483000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(15, 23, 42, 0.55)",
            pointerEvents: "auto"
          },
          onMouseDown: (event) => { if (event && event.stopPropagation) event.stopPropagation(); },
          onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); },
          children: jsx("div", {
            style: {
              width: "min(520px, calc(100vw - 48px))",
              maxHeight: "calc(100vh - 80px)",
              overflow: "auto",
              background: "#fff",
              color: "#1f2328",
              border: "1px solid #d0d7de",
              borderRadius: 12,
              boxShadow: "0 20px 48px rgba(0,0,0,0.28)",
              padding: "20px 22px 16px"
            },
            children: [
              jsx("div", { style: { fontSize: 17, fontWeight: 700, marginBottom: 2 }, children: "免责声明与使用须知" }),
              jsx("div", { style: { fontSize: 12, color: "#6b7280", marginBottom: 14 }, children: "富江破甲插件 · dsh-prompt-custom · v1.1" }),
              jsx("div", { style: { fontSize: 13, lineHeight: "21px" }, children: [

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "一、授权前提" }),
                jsx("div", { style: { margin: "0 0 12px" }, children: "使用本插件前，请确认满足下列任一条件：" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "1）目标为你本人所有的资产；" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "2）已取得目标方书面授权，并明确测试范围与时间窗口；" }),
                jsx("div", { style: { margin: "0 0 12px", paddingLeft: 14 }, children: "3）目标为公开靶场、CTF 赛事或你自建的隔离实验环境。" }),

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "二、使用者责任" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "1）每次测试的目标、范围、频率与影响，由你自行确认并承担相应责任。" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "2）知识库条目与 PoC 供学习、复现与授权评估使用；将其用于未授权系统属于使用者个人行为。" }),
                jsx("div", { style: { margin: "0 0 12px", paddingLeft: 14 }, children: "3）你应当遵守所在地法律法规及与目标方的约定；由此产生的一切后果由使用者本人承担。" }),

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "三、能力与风险提示" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "1）插件提供指纹匹配、PoC 参考、任务台账与自动续跑；实际发包动作由模型在你的环境中执行。" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "2）部分 PoC 具备破坏性（写入文件、重启服务、修改配置），建议先在实验环境验证效果。" }),
                jsx("div", { style: { margin: "0 0 12px", paddingLeft: 14 }, children: "3）自动续跑会在目标未达成时继续推进（默认上限 8 轮），可能产生额外请求与访问日志。" }),

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "四、数据与隐私" }),
                jsx("div", { style: { margin: "0 0 4px", paddingLeft: 14 }, children: "1）任务台账、漏洞报告与安装日志保存在本地 DSH_HOME 目录，插件运行全程离线。" }),
                jsx("div", { style: { margin: "0 0 12px", paddingLeft: 14 }, children: "2）测试中获取的凭据、个人信息与业务数据，请按授权约定保存、使用并及时销毁。" }),

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "五、责任限制" }),
                jsx("div", { style: { margin: "0 0 12px" }, children: "在适用法律允许的最大范围内，插件作者与分发者对使用本插件引发的损失（含数据损坏、业务中断、合规责任）免除赔偿责任。" }),

                jsx("div", { style: { fontWeight: 600, margin: "0 0 4px" }, children: "六、确认" }),
                jsx("div", { style: { margin: "0 0 4px" }, children: "点击「同意并遵守」表示你已阅读、理解并接受上述全部条款，本次运行内有效。" }),
                jsx("div", { style: { margin: "0 0 0" }, children: "点击「拒绝」将立即关闭 DeepSeek Harness；也可直接按 Enter 或 Esc 视为同意。" })
              ] }),
              jsx("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" }, children: [
                jsx("button", {
                  type: "button",
                  onClick: refuse,
                  style: {
                    padding: "7px 14px",
                    fontSize: 13,
                    borderRadius: 8,
                    border: "1px solid #d0d7de",
                    background: "#f6f8fa",
                    color: "#b42318",
                    cursor: "pointer"
                  },
                  children: "拒绝"
                }),
                jsx("button", {
                  type: "button",
                  onClick: accept,
                  style: {
                    padding: "7px 16px",
                    fontSize: 13,
                    fontWeight: 600,
                    borderRadius: 8,
                    border: "1px solid #169760",
                    background: "#169760",
                    color: "#fff",
                    cursor: "pointer"
                  },
                  children: "同意并遵守"
                })
              ] })
            ]
          })
        });
        // 键盘兜底：Enter / Esc 等同于「同意并遵守」，避免浮层点不到时卡死。
        react.useEffect(() => {
          const onKey = (event) => {
            const key = event && event.key;
            if (key === "Enter" || key === "Escape") {
              try { event.preventDefault(); event.stopPropagation(); } catch (error) {}
              try { window.sessionStorage.setItem(KEY, "accepted"); } catch (error) {}
              setOpen(false);
            }
          };
          window.addEventListener("keydown", onKey, true);
          return () => { try { window.removeEventListener("keydown", onKey, true); } catch (error) {} };
        }, [open]);
        if (!open) return null;
        // 挂到 body 上，避免被 slot 容器的 pointer-events / transform 限制。
        try {
          const reactDom = require("react-dom");
          if (reactDom && typeof reactDom.createPortal === "function" && typeof document !== "undefined" && document.body) {
            return reactDom.createPortal(root, document.body);
          }
        } catch (error) {}
        return root;
      }

      function PromptToggle(props) {
        // slot 会通过 inject 注入当前会话 id；拿不到就空串（面板会退回列表选择）。
        const sessionId = props && props.sessionId ? String(props.sessionId) : "";
        const [enabled, setEnabled] = react.useState(false);
        const [phase, setPhase] = react.useState("loading");
        const [busy, setBusy] = react.useState(false);
        const [error, setError] = react.useState("");
        const operation = react.useRef(false);
        const [panelOpen, setPanelOpen] = react.useState(false);
        const panelId = react.useId();

        const refresh = react.useCallback(async () => {
          if (operation.current) return;
          try {
            const resp = await fetch(TOGGLE_URL, { headers: { accept: "application/json" } });
            const data = await resp.json();
            if (!resp.ok || !data || data.ok === false || typeof data.enabled !== "boolean") {
              throw new Error("toggle status unavailable");
            }
            setEnabled(data.enabled);
            setError("");
            setPhase("ready");
          } catch (e) {
            setError(L.toggleError);
            setPhase((current) => current === "ready" ? "ready" : "error");
          }
        }, []);

        react.useEffect(() => {
          refresh();
          window.addEventListener("focus", refresh);
          return () => window.removeEventListener("focus", refresh);
        }, [refresh]);

        const change = async (next) => {
          if (operation.current || phase !== "ready") return;
          operation.current = true;
          setBusy(true);
          setError("");
          try {
            const resp = await fetch(TOGGLE_URL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled: !!next })
            });
            const data = await resp.json();
            if (!resp.ok || !data || data.ok === false || typeof data.enabled !== "boolean") {
              throw new Error("toggle update failed");
            }
            setEnabled(data.enabled);
          } catch (e) {
            setError(L.toggleError);
          } finally {
            operation.current = false;
            setBusy(false);
          }
        };

        return jsxs("div", {
          "data-prompt-custom-overlay": "",
          onClick: (event) => event.stopPropagation(),
          style: {
            // The official overlay anchor sits at the top of the composer card.
            // Stay outside normal layout so the workspace/preset row keeps its native position.
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 8,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            height: 28,
            boxSizing: "border-box",
            margin: 0,
            padding: 0,
            pointerEvents: "none"
          },
          children: [
            jsx("style", { children: PANEL_CSS }),
            jsxs("div", {
              style: { position: "relative", display: "inline-flex", height: 28, pointerEvents: "none" },
              children: [
                jsx("button", {
                  type: "button",
                  className: "dsh-fuj-settings-trigger",
                  "data-prompt-custom-settings": "",
                  "aria-label": L.pluginSettings,
                  "aria-haspopup": "dialog",
                  "aria-expanded": panelOpen,
                  "aria-controls": panelOpen ? panelId : undefined,
                  title: L.pluginSettings,
                  onClick: (event) => { event.stopPropagation(); setPanelOpen(true); },
                  children: jsx(IconSettingsOutlineRegular, { size: 16 })
                }),
                jsxs("button", {
            "data-prompt-custom-toggle": "",
            type: "button",
            role: "switch",
            "aria-label": L.toggleLabel,
            "aria-checked": enabled,
            "aria-busy": busy || phase === "loading",
            disabled: busy || phase === "loading",
            title: error ? error + "，点击重试" : (enabled ? "点击关闭" : "点击开启") + L.toggleLabel,
            onClick: (event) => {
              event.stopPropagation();
              return error || phase === "error" ? refresh() : change(!enabled);
            },
            style: {
              appearance: "none",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              alignSelf: "flex-start",
              flex: "0 0 auto",
              gap: 7,
              width: "max-content",
              minWidth: 0,
              height: 28,
              minHeight: 28,
              maxHeight: 28,
              boxSizing: "border-box",
              margin: 0,
              padding: "0 10px",
              border: "1px solid " + (error ? "rgba(180, 35, 24, 0.28)" : enabled ? "rgba(22, 151, 96, 0.30)" : "var(--dsw-alias-border-l3, #dfe2e5)"),
              borderRadius: 6,
              background: error ? "rgba(180, 35, 24, 0.06)" : enabled ? "rgba(22, 151, 96, 0.08)" : "var(--dsw-alias-background-secondary, rgba(120, 128, 140, 0.06))",
              boxShadow: "none",
              pointerEvents: "auto",
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 500,
              lineHeight: "18px",
              color: "var(--dsw-alias-label-primary, #20252b)",
              whiteSpace: "nowrap",
              cursor: busy || phase === "loading" ? "wait" : "pointer",
              opacity: busy || phase === "loading" ? 0.65 : 1
            },
            children: [
              jsx("span", {
                "aria-hidden": true,
                style: {
                  display: "block",
                  flex: "0 0 6px",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: error ? "#b42318" : enabled ? "#169760" : "#959ca5"
                }
              }),
              jsx("span", {
                style: { display: "block", lineHeight: "18px" },
                children: L.toggleLabel + (error ? "待重试" : phase !== "ready" ? L.toggleLoading : enabled ? L.toggleOn : L.toggleOff)
              })
            ]
                })
              ]
            }),
            jsx(PluginPanel, {
              sessionId,
              id: panelId,
              open: panelOpen,
              onClose: () => { setPanelOpen(false); refresh(); }
            }),
            jsx(DisclaimerGate, {})
          ]
        });
      }

      ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "dsh-prompt-custom-toggle",
        order: 90,
        inject: (sessionId) => ({ sessionId: sessionId === undefined ? "" : String(sessionId) })
      }, PromptToggle));

      // 设置面板是全局的：inject 只是尽力拿到当前会话；拿不到就退回列表选择。
      const registerSettings = (withInject) => () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-prompt-custom",
        order: 60,
        label: () => L.nav,
        ...(withInject ? { inject: (sessionId) => ({ sessionId: sessionId === undefined ? "" : String(sessionId) }) } : {})
      }, (props) => jsx(Card, props));
      try {
        ctx.slots.inject("settings.section", registerSettings(true));
      } catch (error) {
        ctx.slots.inject("settings.section", registerSettings(false));
      }
    }

    const inject = ["slots"];
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
