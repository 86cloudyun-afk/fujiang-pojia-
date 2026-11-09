# DSH Custom Prompt Bundle

This standalone package installs `@deepseek-ai/dsh-prompt-custom` into an official DeepSeek Harness profile and carries the current `prompt-custom.json` configuration separately from the plugin package.

## Install

For DeepSeek Harness Desktop, start the app once to initialize its `desktop` profile, then run `点我执行脚本.cmd`. The installer closes Harness by itself (asks it to close, and ends the process if it is still running after 20 seconds), installs the plugin, and starts Harness again.

```powershell
.\点我执行脚本.cmd              # close Harness -> install -> start Harness
.\install.ps1 -DryRun      # print the plan, change nothing
.\install.ps1 -NoRestart   # install without starting Harness
```

### Antivirus false positives

The installer is a plain PowerShell script that copies files and calls the DSH CLI. It deliberately contains no hidden-window launch, no forced process termination, no scheduled task, and no WMI process creation, which are the behaviours that usually trigger heuristics. It runs under `-ExecutionPolicy RemoteSigned` rather than `Bypass`.

If a scanner still flags it:

1. Right-click the downloaded zip, open **Properties**, tick **Unblock**, then extract again.
2. Or clear the mark-of-the-web for the extracted folder:
   ```powershell
   Get-ChildItem -Recurse | Unblock-File
   ```
3. Verify what you are running before adding any exclusion:
   ```powershell
   Get-FileHash .\install.ps1 -Algorithm SHA256
   ```
   Compare the hash with the one published beside the download.
4. Manual install without any script (recommended when policy forbids scripts):
   ```powershell
   # 1. close DeepSeek Harness
   # 2. copy the folder
   Copy-Item .\plugin "$env:USERPROFILE\.dsh\local-plugins\dsh-prompt-custom" -Recurse -Force
   # 3. register it
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "$env:USERPROFILE\.dsh\local-plugins\dsh-prompt-custom"
   # 4. optional: copy prompt-custom.json into $env:USERPROFILE\.dsh\prompt-custom.json
   # 5. start DeepSeek Harness
   ```

The installer writes `install.log` next to itself, so its behaviour stays auditable without inspecting the script.

The script copies the plugin into `$DSH_HOME\local-plugins\dsh-prompt-custom`, installs it with `dsh plugin --profile <profile> add <path>`, and copies the bundled prompt config to `$DSH_HOME\prompt-custom.json`. If a different prompt config already exists, the script backs it up beside the original before replacing it. A failed plugin install restores the previous prompt config. After restarting Desktop, a compact 28px badge appears just above the center of the composer: a green dot with `富江破甲已激活`, or a gray dot with `富江破甲未激活`. Click the badge to immediately enable or disable prompt injection.

## Compatibility

Click the gear to the left of the centered badge to open the plugin's own settings dialog. It has four tabs: **漏洞报告** (a persisted vulnerability report grouped by 严重/高危/中危/低危/信息, written by the agent through a local HTTP endpoint), **自定义提示词** (the Custom Prompt editor), **技能库** (REA / AboutSecurity downloads), and **知识库** (the bundled CVE/PoC knowledge base, see below). The catalog includes **逆向破解 — Reverse Engineer Anything (REA)** from [morluto/rea](https://github.com/morluto/rea) and **渗透测试 — AboutSecurity** from [wgpsec/AboutSecurity](https://github.com/wgpsec/AboutSecurity). AboutSecurity downloads the current `master` branch archive directly from GitHub, extracts only its `skills/` directory, and registers the 249 discovered skills on enable. Download progress is shown and can be cancelled; enable/disable adds or removes the skill provider, and delete removes only the plugin-owned files. The repository does not include a detected license file or GitHub license declaration, so the deployment package stores only upstream links and does not redistribute the skill corpus or REA installation files.

## Automation (campaign ledger + fingerprint matching)

Two local endpoints drive the loop without any network access:

- `POST /api/dsh-prompt-custom/match` — feed a port, banner or product name and get ranked knowledge-base hits with the reason each one matched (port 40 / product 30 / CVE 20 / keyword 20 / critical 5). The index is built from the corpus frontmatter at runtime, so new entries are matched immediately.
- `/api/dsh-prompt-custom/campaigns` — a persisted campaign ledger in `$DSH_HOME/vuln-report/campaigns.json`: scope (domains/CIDRs/exclude), assets with fingerprints, steps, attempts, and a stage machine (recon → fingerprint → match → verify → exploit → lateral → report). `GET ?id=` also returns a `next` block with the next stage and, for every pending asset, the knowledge-base entries worth trying.

The **渗透作业链** tab (Chinese stages: 信息收集 → 指纹识别 → 漏洞匹配 → 可行性验证 → 漏洞利用 → 横向移动 → 报告输出) shows campaigns, assets, the last steps and the next suggestion, with a one-click stage advance. A campaign can be **bound to one conversation**: the plugin then injects a `campaign:context` prompt section into that agent (task, stage, asset count, next suggestion) and, right after the user creates the campaign in a single-session window, calls `agent.followup(...)` so the agent starts working without another message. `bind` / `unbind` / `kick` are available over the campaigns endpoint; one conversation holds at most one campaign. **Campaigns can only be created from this tab by the user** — the HTTP route rejects creation calls without a same-origin browser marker (`sec-fetch-site`), and the `campaign_upsert` tool refuses to create one, so the agent can only record into a campaign the user opened. When `@deepseek-ai/dsh-tools` is resolvable the plugin also registers native tools (`kb_match`, `campaign_upsert`, `finding_upsert`, `pipeline_next`); when it is not, everything stays available over the same HTTP endpoints — no startup failure either way.

## Knowledge base (CVE / PoC)

**知识库** is bundled: `plugin/knowledge/` ships with the package, so enabling it performs no download, resolves no host, and touches no network. It ships **110 entries in nine model-invocable skills** registered through `skills.registerProvider`, so the agent sees them in its `available_skills` catalog and can load a category's body on demand:

| Skill | Coverage |
| --- | --- |
| `kb-java-deser` | Log4Shell, Spring4Shell, Struts2 S2-045, WebLogic T3 / wls-wsat / JNDI, Shiro rememberMe, Fastjson autoType, Java ECDSA psychic signatures |
| `kb-java-web` | Confluence OGNL (pre-auth and post-auth), Confluence SSTI, Confluence setup-restore takeover, GitLab ExifTool, Jenkins CLI file read, TeamCity auth bypass, Solr Velocity, Tomcat AJP Ghostcat, Struts2 S2-066 |
| `kb-edge-device` | PAN-OS GlobalProtect, Ivanti chain, Pulse file read, CitrixBleed, Citrix path traversal, FortiOS traversal / 2FA case bypass / XORtigate, F5 iControl |
| `kb-exchange-ad` | ProxyLogon, ProxyShell, ProxyNotShell, ViewState, Zerologon, noPac, AD CS ESC1/ESC8, PrintNightmare, MS17-010, BlueKeep, Outlook NTLM leak |
| `kb-web-cms` | Drupalgeddon2, Drupal REST, PHP-FPM underflow, PHP-CGI Windows, Laravel Ignition, ThinkPHP 5.x, vBulletin, Apache httpd traversal, Joomla config leak |
| `kb-linux-priv` | PwnKit, Dirty Pipe, Baron Samedit, fs_context overflow, GameOver(lay), nf_tables, Looney Tunables, overlayfs |
| `kb-cloud-container` | runc escape (2019-5736 and Leaky Vessels 2024-21626), cgroups release_agent, Docker API, K8s API proxy, Redis, PostgreSQL COPY, Nacos |
| `kb-gray-market` | Grey-market site surface (21): source/backup/config leaks, client-side signature forgery, API BOLA, agent-hierarchy escalation, member PII enumeration, payment-notify forgery, withdrawal-approval IDOR, balance race/negative amounts, promotion idempotency, game-vendor callback forgery, predictable lottery PRNG, customer-service WebSocket, upload getshell, SMS bombing, RuoYi/Druid, Actuator, JWT, public OSS buckets, export path traversal, business SQLi, SSRF |
| `kb-triage` | fingerprint-to-CVE workflow, safe verification and evidence rules, report template |

Entries are **public-material digests, not first-hand research**: every file carries `verified: false` and `sources:` in its frontmatter, and its 利用步骤 are hypotheses to be confirmed against the target version. Every entry is one Markdown file with a frontmatter block (`title`, `cve`, `severity`, `cvss`, `product`, `versions`, `ports`, `keywords`) and six sections: 指纹 / 前置条件 / PoC / 利用步骤 / 修复与缓解 / 参考. The provider's `get()` re-reads the file on every load, so editing the corpus takes effect on the next skill invocation without restarting DSH; only adding or removing a category needs a restart (the category list lives in `lib/knowledge.js`).

Enable or disable it with the switch on the Skill Library page. The choice persists in `$DSH_HOME/fujiang-skills/knowledge-state.json` and the feature is **on by default**. Because the corpus ships with the package, there is no install button and no delete button — disabling removes the provider from the catalog and the files stay where they are.

REA requires a compatible Node.js version (`^22.23.4 || ^24.22.1 || >=26.12.1`). The installer uses npm with lifecycle scripts disabled. Static REA MCP tools and Windows packaged native support are available; Frida's optional native binding is not built by this install mode. AboutSecurity is a Markdown skill corpus and requires no extra runtime dependencies.

The badge uses the official `conversation.input.overlay` slot and takes no space in the composer stack. The workspace and agent preset controls retain their original spacing and position.

When custom prompt injection is active, the plugin shadows only the official `harness:identity` opener with an empty section. Your custom prompt text is left untouched. Disabling custom injection restores the official opener.

The package declares compatibility with DSH and `dsh-system-prompt` `>=0.2.1-rc.5 <0.3.0`, and Cordis `>=4.0.5 <5`. DSH's plugin manager checks these declarations before installation.

The plugin uses the public `systemPrompt`, `skills`, `tools`, agent lifecycle, and `webServer` services. It does not patch Harness files. Fully exit and restart DSH after installation.

## Private prompt config

This bundle contains your current prompt configuration. Keep the archive private. Before sharing it, replace or remove `prompt-custom.json`.
