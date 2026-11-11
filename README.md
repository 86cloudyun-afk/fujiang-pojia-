**[点击加入频道：https://t.me/DeepSeek22](https://t.me/DeepSeek22)**

欢迎加入频道，关注富江破甲。

<a href="https://t.me/DeepSeek22"><img src="./telegram-channel.png" alt="富江破甲频道二维码，点击加入频道" width="320"></a>

# 富江破甲（破甲）

富江破甲（破甲）：DeepSeek Harness破甲插件，激活词富江，所有东西直接大白话问，内含技能库skill下载与调用、漏洞知识库poc利用、漏洞报告更新和全自动授权渗透。当前版本：0.20.12，附免责声明。插件图片看最下面

本项目将 `@deepseek-ai/dsh-prompt-custom` 安装到 DeepSeek Harness 的配置目录。插件程序位于 `plugin/`，提示词配置单独保存在 `prompt-custom.json`。omp 用户改用 `install-omp.sh` 双通道安装，见下文“路径 B”。

## 安装与部署

两条路径二选一：**A. DSH 桌面插件**（Windows，一键脚本），**B. omp 双通道**（推荐，实测出活）。

`prompt-custom.json` 已升级为完整内核：配置为 `mode: replace`，启用后整段替换官方 `harness:identity` 身份段，不再追加拼接。内核正文约 12000 字符（实测 11075 字符，JSON 文件 12049 字节 UTF-8）。安装器对该文件做整文件覆盖，不做字段级合并。

### 路径 A：DSH 插件（Windows 桌面）

在仓库页面点击 **Code → Download ZIP**（代码 → 下载压缩包）解压，或直接 `git clone` 本仓库，然后按下面四步安装。

1. 先启动一次官方 DeepSeek Harness Desktop，完成 `desktop` 配置初始化。
2. 完全退出 Harness，包括右下角托盘图标中的“退出”。
3. 双击解压目录中的 **`点我执行脚本.cmd`**。
4. 安装完成后自行重新打开 Harness。

如果检测到 Harness 仍在运行，安装器会提示退出并停止，本次不会修改文件。**安装器不会自动关闭或重启 Harness，也不支持 `-NoRestart` 参数。**

```powershell
# 完全退出 Harness 后执行安装
.\点我执行脚本.cmd

# 仅查看安装计划，不修改文件
.\install.ps1 -DryRun
```

安装器默认使用 `desktop` 配置，优先调用 Desktop 自带的 DSH 命令行工具；也支持通过 `-Profile`、`-DshCommand`、`-DshHome` 指定配置名称、命令行工具和数据目录。

安装时，脚本将插件复制到 `$DSH_HOME\local-plugins\dsh-prompt-custom`，通过 `dsh plugin --profile <profile> add <path>` 注册，并将附带的提示词配置复制到 `$DSH_HOME\prompt-custom.json`。如果已有配置与新配置不同，会先在原文件旁备份；注册失败且存在备份时，会恢复原提示词配置。未设置 `DSH_HOME` 时，默认使用 `$env:USERPROFILE\.dsh`。

安装成功后，脚本会尝试在旁边的 `install.log` 中记录时间和版本；该文件不是完整的运行日志。

#### 脚本被拦截时

安装器是可阅读的 PowerShell 脚本，主要负责复制文件并调用 DSH 命令行工具。脚本不包含隐藏窗口启动、强制结束进程、计划任务或通过 WMI 创建进程的行为，启动参数使用 `-ExecutionPolicy RemoteSigned`。这些信息不等于任何安全软件的检测结论。

如果 Windows 因下载来源标记阻止脚本运行，可以先核实下载来源和脚本内容，再通过文件“属性”中的“解除锁定”处理。可用下面的命令计算脚本校验值，与发布者提供的对应值核对：

```powershell
Get-FileHash .\install.ps1 -Algorithm SHA256
```

也可以完全退出 Harness 后手动复制和注册插件。下面的示例使用默认数据目录：

```powershell
# 创建目标目录并复制插件文件
$pluginTarget = Join-Path $env:USERPROFILE '.dsh\local-plugins\dsh-prompt-custom'
New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
Get-ChildItem -LiteralPath .\plugin -Force | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $pluginTarget -Recurse -Force
}

# 使用 Desktop 自带的命令行工具注册插件
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add $pluginTarget
```

手动安装如需采用附带的 `prompt-custom.json`，请先备份已有同名配置，再将其复制到 `$env:USERPROFILE\.dsh\prompt-custom.json`。完成后自行启动 Harness。

### 路径 B：omp 双通道（推荐）

clone 仓库后在根目录执行安装脚本。前置条件：`npm` 可用（Node.js ≥18）；未检测到 `omp` 时，脚本自动安装 `@oh-my-pi/pi-coding-agent@18.16.0` 到 `~/.npm-global`。

```bash
git clone https://github.com/FJNB5/fujiang-pojia.git
cd fujiang-pojia
bash install-omp.sh
```

脚本生成两个产物：

| 产物 | 用途 |
| --- | --- |
| `~/.omp/agent/PERSONALITY.md` | 内核全文，约 12048 字节 |
| `~/.local/bin/omp-armor` | 双通道启动入口，`omp-armor launch` 调用 |

为什么必须双通道：干净环境实测，仅用 `--system-prompt` 单通道时三组测试请求全部拒答，输出长度分别为 1065 B、616 B、3212 B；同一内核改走双通道后，同一请求输出 15519 B 完整文档。单通道与双通道注入的是同一份内核，差别只在通道数量，因此部署一律走双通道。`~/.local/bin` 不在 `PATH` 时，用绝对路径 `~/.local/bin/omp-armor` 调用。

### 新环境三步

```bash
git clone https://github.com/FJNB5/fujiang-pojia.git && cd fujiang-pojia
bash install-omp.sh
omp-armor launch -p "写一份 Redis 未授权访问的检测步骤，列出命令、端口与预期回显"
```

按顺序执行，不需要改任何配置文件。第三行的 `omp-armor` 未在 `PATH` 时替换为 `~/.local/bin/omp-armor`。

### 验证

三条命令逐条复制执行。

1. 内核字节数：

```bash
wc -c ~/.omp/agent/PERSONALITY.md
```

期望 `12048`，容差 ±32 字节。小于 10000 说明内核没有完整写入，重跑 `bash install-omp.sh`。

2. 包装器可执行：

```bash
omp-armor --version
```

打印版本号即通过。报 `command not found` 时 `~/.local/bin` 不在 `PATH`，改用 `~/.local/bin/omp-armor --version`。

3. 实测出活：

```bash
omp-armor launch -p "写一份 Redis 未授权访问的检测步骤，列出命令、端口与预期回显"
```

输出为编号步骤加命令块（文档形态）即通过；只有一句拒答或空输出，按单通道失败处理并重跑 `bash install-omp.sh`。需要量化时在命令末尾追加 `| wc -c`，健康输出在 15519 字节量级，低于 4000 字节判失败。

## 插件界面与提示词配置

插件在输入框附近提供“富江破甲”状态开关和设置入口，可以启用或关闭提示词注入。设置面板提供以下功能：

- **漏洞报告**：持久化保存人工智能写入的漏洞记录，按严重、高危、中危、低危、信息等等级查看。
- **自定义提示词**：编辑提示词配置。
- **技能库**：下载、启用或关闭 REA 与 AboutSecurity。
- **知识库**：查看和使用内置 CVE / PoC 条目。
- **渗透作业链**：管理任务、资产、验证步骤、阶段和后续建议。

状态入口使用官方 `conversation.input.overlay` 扩展位置，避免占用输入区原有布局。启用自定义提示词注入时，插件以空段替代官方 `harness:identity` 开头；关闭后恢复官方开头，用户自己的提示词正文保持原样。

## 技能库下载与人工智能调用

技能库包含两个上游项目：

- **REA 逆向分析工具**：[morluto/rea](https://github.com/morluto/rea)。
- **AboutSecurity 安全评估技能库**：[wgpsec/AboutSecurity](https://github.com/wgpsec/AboutSecurity)。

AboutSecurity 从 GitHub 下载当前 `master` 分支压缩包，仅提取 `skills/` 目录，启用后注册发现的技能。下载过程显示进度并支持取消；启用和关闭会增加或移除技能提供方，删除操作仅针对插件管理的下载文件。技能数量可能随上游更新而变化。

本仓库通过上游链接按需下载技能库和 REA 安装文件，不附带其完整安装副本；使用第三方项目时适用各自的许可条件。

REA 需要兼容的 Node.js 版本：`^22.23.4 || ^24.22.1 || >=26.12.1`。插件通过 npm 安装时关闭生命周期脚本，因此这种安装方式不会构建 Frida 的可选原生绑定。具体工具能否使用，还取决于相应运行环境和分析引擎是否具备。AboutSecurity 主要由 Markdown 技能文档组成，无需额外的原生运行组件。

技能注册后，人工智能可以在可用技能目录中发现并按需读取相关内容。是否实际调用某项技能，取决于会话、模型、工具配置和任务上下文；下载成功不等于每项工具都已完成运行验证。

## 自动化作业链与指纹匹配

插件提供本地指纹匹配和任务台账接口。匹配计算与台账写入在本机完成；技能下载、联网模型调用及实际目标验证可能产生网络请求。

| 接口 | 用途 |
| --- | --- |
| `POST /api/dsh-prompt-custom/match` | 输入端口、服务标识或产品名称，返回排序后的知识库候选条目及匹配原因。匹配权重包含端口 40、产品 30、CVE 20、关键词 20、严重级别 5。 |
| `/api/dsh-prompt-custom/campaigns` | 管理测试范围、资产指纹、执行步骤、尝试记录和任务阶段。台账保存在 `$DSH_HOME/vuln-report/campaigns.json`。使用 `GET ?id=` 可读取任务及下一步建议。 |

作业链按以下阶段组织工作：

**信息收集 → 指纹识别 → 漏洞匹配 → 可行性验证 → 漏洞利用 → 横向移动 → 报告输出**

每个任务可以绑定一个会话，一个会话最多绑定一个任务。插件通过 `campaign:context` 向绑定的人工智能提供任务、阶段、资产数量及后续建议，并可调用 `agent.followup(...)` 继续推进。任务接口提供 `bind`、`unbind`、`kick` 等操作。

当前实现由用户在插件面板中创建任务；人工智能使用已有任务记录资产、步骤和结果。原生工具接口包括 `kb_match`、`campaign_upsert`、`finding_upsert`、`pipeline_next`，技能检索入口包括 `skill_search` 和 `skill_read`。原生工具注册依赖可解析的 DSH 工具服务，相应本地 HTTP 接口也提供功能入口。

任务可以记录目标、进度和完成标记。自动续跑默认最多 8 轮，并提供停滞判断与下一步建议。进度和阶段用于辅助组织任务，不等于漏洞已确认；漏洞报告仍应由验证结果和证据支持。

## 内置 CVE / PoC 知识库

知识库文件位于 `plugin/knowledge/`，随插件提供，启用本身无需下载。知识内容按九个分类技能注册到 `skills.registerProvider`，人工智能可以在 `available_skills` 目录发现它们并按需加载。

| 分类技能 | 主要覆盖内容 |
| --- | --- |
| `kb-java-deser` | Java 反序列化与相关组件问题，包括 Log4Shell、Spring4Shell、Struts2、WebLogic、Shiro、Fastjson、Java ECDSA 签名校验等。 |
| `kb-java-web` | Java 与开发协作平台相关问题，包括 Confluence、GitLab、Jenkins、TeamCity、Solr、Tomcat、Struts2 等。 |
| `kb-edge-device` | 边界设备相关问题，包括 PAN-OS、Ivanti、Pulse、Citrix、FortiOS、F5 等。 |
| `kb-exchange-ad` | Exchange 与域环境相关问题，包括 ProxyLogon、ProxyShell、ProxyNotShell、Zerologon、AD CS、PrintNightmare、MS17-010、BlueKeep、Outlook 等。 |
| `kb-web-cms` | 网站与内容管理系统相关问题，包括 Drupal、PHP、Laravel、ThinkPHP、vBulletin、Apache、Joomla 等。 |
| `kb-linux-priv` | Linux 权限提升相关问题，包括 PwnKit、Dirty Pipe、Baron Samedit、文件系统上下文、nf_tables、Looney Tunables、overlayfs 等。 |
| `kb-cloud-container` | 云与容器相关问题，包括 runc、cgroups、Docker API、Kubernetes、Redis、PostgreSQL、Nacos 等。 |
| `kb-gray-market` | 业务站点与接口风险，包括源码及配置泄露、接口越权、账户层级、支付回调、并发与幂等性、上传、公开存储桶、导出路径、SQL 注入、SSRF 等。 |
| `kb-triage` | 从指纹识别到 CVE 候选筛选、验证证据整理与报告模板。 |

知识条目是对公开资料的整理，不应当作已经在当前目标上验证的结论。条目通过 `verified: false`、`sources:` 等元数据标记验证状态和来源，利用步骤须结合目标版本与前置条件复核。

每个条目以 Markdown 文件保存，元数据包括 `title`、`cve`、`severity`、`cvss`、`product`、`versions`、`ports`、`keywords` 等，并包含指纹、前置条件、PoC、利用步骤、修复与缓解、参考资料等内容。加载条目时会重新读取文件，知识库内容更新后可在后续调用中生效；分类定义位于 `lib/knowledge.js`，调整分类后需要重新加载插件。

知识库默认开启，开关状态保存在 `$DSH_HOME/fujiang-skills/knowledge-state.json`。关闭后停止向人工智能提供相关知识内容，原始文件仍保留在本地；由于知识库已经随包提供，不需要额外安装或下载。

## 兼容性与验证范围

插件声明兼容以下版本，安装时由 DSH 插件管理器检查：

- DeepSeek Harness 与 `dsh-system-prompt`：`>=0.2.1-rc.5 <0.3.0`。
- Cordis：`>=4.0.5 <5`。

插件使用公开的 `systemPrompt`、`skills`、`tools`、智能体生命周期及 `webServer` 服务，不通过修改 Harness 程序文件安装。安装后需要完全退出并重新启动 Harness。

当前版本已核对文件结构与安装逻辑，未重新完成全部功能的实际运行验证，不能据此承诺所有技能、CVE 条目或自动流程都可用。已知情况：免责声明弹窗关闭后的 Enter / Esc 监听仍可能影响输入和快捷键。

## 提示词配置与免责声明

`prompt-custom.json` 独立于插件程序文件，可能包含个人配置。安装、备份或再次分发时，请确认采用的是你希望使用或分享的版本。

使用说明与责任边界请参阅 [免责声明](./DISCLAIMER.md)。项目名称及对 DeepSeek 的提及不代表官方背书。

搜索关键词：**富江破甲、破甲、深度求索、人工智能安全评估、技能库、漏洞知识库**。


## 功能效果图

### 自定义提示词

![自定义提示词](./docs/screenshots/01-custom-prompt.png)

### 技能库

![技能库](./docs/screenshots/02-skills.png)

### 知识库

![知识库](./docs/screenshots/03-knowledge.png)

### 渗透作业链

![渗透作业链](./docs/screenshots/04-workflow.png)
