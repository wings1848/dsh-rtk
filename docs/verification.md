# 验收证据

本文件记录 `dsh-rtk` 的**闸门留痕**：每条关于框架行为的断言都配一条可复现命令与实测输出；每个回归测试都留下一次「修复前失败」的记录。

日期：2026-09-12 · 环境：Node v26.7.0 · rtk 0.48.0 · DSH 0.1.5-rc.1

---

## 1. 事实核对（动手前完成）

这些断言决定了架构选择。每一条都用命令实测过，不是从文档推断的。

| 断言 | 命令 | 实测输出 |
|---|---|---|
| `rtk rewrite` 存在并输出等价命令 | `rtk rewrite "ls -la"` | `rtk ls -la`，exit 3 |
| rtk 的警告写 stderr，stdout 干净 | `rtk rewrite "ls -la" 2>/dev/null` | 只有命令本身（若警告混进 stdout，改写结果会被污染） |
| rewrite 退出码语义 | `for c in "ls -la" "echo hi" "git status"; do rtk rewrite "$c"; echo $?; done` | `ls -la`→3、`git status`→3、`echo hi`→1 且无输出 |
| rewrite 足够快，可放在每次 bash 调用前 | `time rtk rewrite "git status"` | real 0m0.026s |
| 复合命令与 env 前缀能正确改写 | `rtk rewrite "git status && cargo test"` / `rtk rewrite "FOO=1 ls -la"` | `rtk git status && rtk cargo test` / `FOO=1 rtk ls -la` |
| `tools/post-execute` 可以替换工具结果内容 | 动态 Cordis 插件：监听 post-execute，剥离 ANSI 并追加诊断行 | `[rtk-probe] call#1 blocks=1 ansiStripped=1 ...` 出现在模型可见输出中 |
| post-execute 的 `next()` 返回值**不带** content | 同上 | `decisionHadContent=false` — 原始内容必须从 `result.content` 取 |
| `tools/execute` 可以替换 `exec.arguments` 且真正生效 | 动态 Cordis 插件：把命令替换为 `echo "RTK-REWRITE-PROVEN-1"` | 实际执行的是替换后的命令，原命令未运行 |
| `tools/pre-execute` 不能改写参数 | `@deepseek-ai/dsh-tools` 类型注释 + `PreToolDecision` 定义 | 决策只有 `allow`/`deny`/`ask`；注释写明 "Input rewriting is excluded because arguments are already logged and presented" |
| `bash` 工具不在全局层，而在 preset 层 | 动态插件 `ctx.tools.get('bash')` | `baseFound: false`；读 `cordis` preset 组合文件确认 `dsh-tool-bash` 是 preset 的一行 |
| preset 的 standing scope 是每个会话 scope 的祖先 | `@deepseek-ai/dsh-scope` 的 `bindScopeParent` + `chainLayers` 实现 | 祖先层的 listener 能收到后代的事件（`scopeTarget`: "admits tagged listeners for a matching key or any of its ancestors"） |

**由这些断言推出的两处架构决策：**

1. **命令重写只能走 `tools/execute`。** pre-execute 被设计为不可改参数，`ctx.tools.register` 在同一 layer 内重复注册同名工具会失败（preset 的所有行共享一个 layer），而从 preset 内部又拿不到 agent 自己的 scope。around-dispatch 是唯一能改「实际执行什么」的接缝。
2. **插件是 agent 平面的一行，不发布服务。** 因此不需要 `isolate` realm，也不该放 host 组合。

---

## 2. 验收标准表

| # | 标准 | 判定命令 | 期望 | 实测 |
|---|---|---|---|---|
| 1 | 类型检查通过（用真实 harness 类型） | `tsc -p tsconfig.json --noEmit` | 无输出、exit 0 | PASS |
| 2 | 构建产出 `lib/` | `tsc -p tsconfig.json && ls lib/index.js` | 文件存在 | PASS |
| 3 | 全部测试通过 | `node --run test`（先构建再测） | `pass 92 / fail 0` | PASS |
| 4 | 模块导出符合 cordis 插件约定 | `node -e "import('./lib/index.js').then(m=>console.log(Object.keys(m)))"` | `Config, apply, inject, name`（与 `dsh-tool-bash` 同约定） | PASS |
| 5 | 模块能被宿主解析 | `~/.dsh/node_modules/dsh-rtk` 软链存在；插件**实际生效**（见第 6 节） | 组合与加载均成功 | PASS |
| 6 | preset 方案当初能被真实组合引擎挂载 | 动态插件调用 `agentPresets.standingKeyFor('rtk')` | `MOUNT OK`（修复前、修复后各一次） | PASS（该平面最终被 host 取代，见第 5 节） |
| 7 | host patch 语法正确并被组合 | `dsh --profile web --dump-config \| grep -A3 "id: rtk"` | 组合树中出现 `- id: rtk / name: dsh-rtk` | PASS（**最终采用**） |
| 8 | bash 真被改写（端到端） | host 平面重启后运行 `ls -la <dir>`（**不带管道**） | 输出为 rtk 紧凑格式 | **PASS**——见第 6 节 |

---

## 3. 验红记录（测试确实能失败）

### 验红 #1 — 移除退出码标记保护

注入方式：把 `compactBashText` 中 `renderBashResult({ ..., markers: parts.markers })` 的 `markers` 改为 `[]`。

```
✖ compaction preserves the harness contract
ℹ tests 50
ℹ pass 44
ℹ fail 6
✖ failing tests:
✖ keeps the exit-code marker through a git rewrite
✖ keeps a non-zero exit marker
✖ keeps a stderr section alongside the marker
✖ never inflates a result
✖ strips ANSI codes but keeps the marker
✖ refuses to cut through a marker when truncating
```

恢复后复测：`tests 50 / pass 50 / fail 0`。

### 验红 #2 — 移除「永不增大」守卫

注入方式：把 `if (rendered.length >= text.length) return { text, techniques: [] }` 改为 `if (false) ...`。

第一次跑**全部通过** —— 说明原用例（`'x\n[exit code: 0]'`）根本没触发这条守卫（该输入不匹配 git status 的原始格式，压缩器本来就返回 null）。这是一处**真实的测试盲区**，被验红抓出来了。

修正用例为 `'## main\n[exit code: 0]'`（合法 status 正文，其摘要 `Branch: main` 更长，只有守卫能保住原文）后重跑：

```
✖ never inflates a result
ℹ tests 50
ℹ pass 49
ℹ fail 1
```

恢复后复测：`tests 50 / pass 50 / fail 0`。

> 两次验红都在 `test/compact.test.ts` 上做，因为这两条正是默认开启路径上的不变量。验红当时套件为 50 项；补入 `integration.test.ts`（`apply()` 接线 + 真实 rtk 二进制）与 `plugin-surface.test.ts`（可执行解析、运行时守卫、统计、`/rtk` 全部子命令）后为 84；独立复核后又补入 `regressions.test.ts` 的 8 项，现为 92。**注**：这些注入验红改的是 `lib/`（测试的目标是构建产物），`src/` 的同类改动不重新构建就测不出来——这一点由复核者指出（第 8 节 D4）并已修复。

---

## 4. 不变量

| 不变量 | 类型 | 实测值 |
|---|---|---|
| `bash` 结果的状态标记在压缩后原样保留 | 测试 | `[exit code: N]`、`[stderr]`、`[timed out after …]`、`[sandbox: …]`、截断提示，均有断言覆盖 |
| 压缩结果永不大于原文 | 测试 | 每条技术路径都走「不短于原文就放弃」守卫；命门用例见验红 #2。**此条曾被违反**：`read` + 源码过滤路径的守卫未把 banner 计入长度，实测 +31 字符。已修复并新增回归用例，见第 8 节 D1 |
| 压缩失败不影响工具调用 | 测试 | `never breaks a tool call when compaction throws`：content 非数组时按原样 accept |
| 改写只作用于单次调用，随后恢复原参数 | 测试 | `rewrites a supported command and restores the original afterwards` 断言派发后 `exec.arguments.command === 'git status'` |
| rtk 不可用时命令原样执行 | 测试 | `degrades to the original command when rtk cannot be resolved`（指向不存在的二进制） |
| 配置数值被钳制在公布区间 | 测试 | `clamps truncation budgets to their published bounds`（maxChars 1000–200000、maxLines 40–4000） |
| 关闭总开关后行为完全惰性 | 测试 | `does nothing at all when disabled` |

---

## 5. 安装方式的取舍（一次回滚留痕）

最初按「与 pi-rtk-optimizer 体验一致（装了全局生效）」把插件装到 host 平面：`~/.dsh/cordis.patch.yml` 追加 `- id: rtk`。`--dump-config` 证实该行被正确组合。

但随后 `standingKeyFor('rtk')` 的 mount 验证失败：

```
- failed to apply loader entry rtk (dsh-rtk): settings namespace "dsh-rtk" is already registered
- failed to apply loader entry tool-cordis (@deepseek-ai/dsh-tool-cordis): Host Cordis inspect provider "Service" is already registered
```

两条错误，两种修法：

1. **`settings` 命名空间是进程级全局的** —— host 行与 preset 行不能同时存在。插件内已改为 `try/catch` 降级：注册失败的实例改为通过 `settings/updated` 事件跟随已注册的实例，**配置便利性绝不能让整个 preset 挂载失败**。
2. **`tool-cordis` 注册进程级 Cordis inspect provider** —— `cordis` preset 的副本会与正在运行的 `cordis` 会话冲突。已从 `rtk` preset 副本中移除该行，并留注释说明需要自我修改时切回 `cordis` preset。

**最终处置（用户决定）：采用 host 平面。** 用户希望「装上就一直生效」，与 `pi-rtk-optimizer` 作为全局扩展的体验一致；preset 方案需要每次新建会话手动选择。于是重新写入 host patch，并删除已被取代的 `rtk` preset 目录。

中间为排查冲突曾回滚过一次 host patch，回滚后重新 mount preset 得到：

```
[rtk-diag] rtkNamespaceRegistered=false namespaces=[...] MOUNT OK; key=[object Object]
```

`rtkNamespaceRegistered=false` 同时反证了 host 行从未真正激活（`ls` 也一直是原生格式），因此上述冲突来自首次失败的 mount 残留，而非 host 行。

---

## 6. 端到端验证（PASS）

**最终形态：host 平面。** 插件行写在 `~/.dsh/cordis.patch.yml`，模块经 `~/.dsh/node_modules/dsh-rtk` 软链解析，宿主重启后对**所有会话**生效。

### 6.1 配置被正确组合

```
$ dsh --profile web --dump-config | grep -A5 "^- id: rtk"
647:- id: rtk
648-  name: dsh-rtk
649-  config:
650-    enabled: true
651-    mode: rewrite
```

### 6.2 命令确实被改写（决定性证据）

重启宿主后，模型发出 `ls -la $HOME/.agents/`（**不带管道**），实际返回：

```
755  .git/
755  skills/
644  .gitignore  796B
644  .skill-lock.json  15.6K
644  AGENTS.md  5.2K
600  doctor.py  9.1K
```

这是 rtk 的 token-optimized 格式——权限位折叠成八进制、无 owner/日期列、目录在前、大小带单位。同一目录的原生格式是：

```
$ /bin/ls -la $HOME/.agents/ | head -3
-rw-r--r-- 1 wings wings  796  .gitignore
```

两者逐列不同，改写生效无疑。

### 6.3 三条对照实验的解读

| 命令 | 结果 |
|---|---|
| `ls -la <dir>`（无管道） | rtk 格式 → **被改写** |
| `rtk ls -la <dir>`（已带 rtk） | rtk 格式 → 被跳过改写，但结果相同 |
| `/bin/ls -la <dir>` | 原生格式 → 未被改写（rtk 不认绝对路径形式） |

### 6.4 一个必须知道的行为：带管道的命令不会被改写

```
$ rtk rewrite "ls -la /tmp"            → exit 3   rtk ls -la /tmp
$ rtk rewrite "ls -la /tmp | head -5"  → exit 1   （无输出）
```

**rtk 对含管道的命令保守跳过改写**——这是 rtk 自身的支持策略，插件忠实转发。排查期间一度误判为缺陷，实为测试命令自带了 `| head`，绕过了改写。用户若想让某条命令走 rtk，去掉管道（或用 `rtk …` 显式调用）。

### 6.5 `/rtk` 命令在真实环境已注册

交付的能力里，命令改写与输出压缩已直接观察到；`/rtk` 是最后一项未在真实会话中确认的。用动态插件读取宿主的命令注册表（一次 bash 调用触发）：

```
[rtk-cmd] rtkCommand=FOUND (RTK command rewriting and output compaction: sta)
          | all=[compact,export,feedback,goal,permission,plan,rtk]
```

`rtk` 出现在该 agent 可见的命令列表中。用户可自行输入 `/rtk`、`/rtk verify`、`/rtk stats` 复核。

### 6.6 另一条被 harness 拒绝的路径（留档）

曾尝试把**正在运行的会话**重挂到 preset 以取得进程内证据，`agentPresets.select` 明确拒绝：

```
[rtk-switch] SELECT FAIL: session "session-44856891-…" has already started; its agent preset is fixed
```

**preset 在会话创建时锁定**，这是 harness 的设计约束。`SubagentStartRequest` 也没有 preset 覆盖字段（只有 `label`/`prompt`/`parent`/`signal`/`agentOptions`），所以 subagent 同样继承父会话 preset、无法用于验证。这也是最终选择 host 平面的原因之一：host 层是进程级的，重启即对**包括当前会话在内**的所有会话生效。

## 7. 已知限制

- **流式 bash 输出未清洗。** Pi 有 `tool_execution_start/update/end` 钩子可以边流边清洗；harness 没有对应事件，故未移植。
- **Windows 兼容修正与 hashline 锚点保护的 read 处理未移植。** 目标部署是 POSIX，且 harness 的 `read` 输出格式与 Pi 不同（read 压缩默认关闭，影响面为零）。
- **`/rtk` 没有交互式设置面板。** harness 的 TUI 设置面板是 client 侧能力；配置改由 `dsh-rtk` settings 命名空间承载，可用 `/rtk show` 查看、在设置文档中修改。
- **含管道的命令不会被改写。** `rtk rewrite` 对 `cmd | other` 返回 exit 1（不支持），插件随之原样执行。这不是缺陷，是 rtk 的支持策略；但意味着 `ls | head` 这类常见写法享受不到优化。
- **`pwsh` 的环境前缀已按 PowerShell 方言分派**（`$env:NAME = '…'`，不是 POSIX 的 `export`）；修复前 Windows 上每次被改写的 pwsh 调用都会语法错误。**本机无 pwsh，该项仅由单元测试覆盖，未真机执行。**
- **验收第 8 项依赖一个真实会话。** 前 7 项都能在进程外复现；第 8 项需要新建一个使用 `rtk` preset 的会话。

---

## 8. 独立复核（subagent）与修复

由另一个 agent 独立复核（不共享本对话上下文）：自行跑测试、读 harness 源码核实接口断言、做注入验红、与 pi 版逐文件对照。裁决为「核心结论**部分成立**」，共找出 5 处真实缺陷。

**全部已修**，且每一条都**先由我独立复现再修**——不是直接采信复核者的描述：

| 编号 | 级别 | 缺陷 | 我的复现 | 修复 |
|---|---|---|---|---|
| D1 | 高 | `compactReadText` 的「永不增大」守卫在拼 banner **之前**执行，`read` + 源码过滤路径实测 `1487 → 1518`（+31 字符）且 `changed=true` | `test/regressions.test.ts` 的 banner 用例，修前失败 | banner 计入长度比较 |
| D2 | 中高 | post-execute 重建 decision 时吞掉内层 listener 的 `additionalContexts`；shipped 的 `dsh-tool-fs-search` 在结果被截断时正是这样返回 | `preserves contexts attached by an inner listener`，修前失败 | 重建时透传 `additionalContexts` |
| D3 | 中 | `pwsh` 也是改写目标，却统一加 POSIX 前缀 `export …` → Windows 上语法错误 | 三个 PowerShell 语法用例，修前失败 | `applyRtkHistoryScope` 增加 shell 方言参数，按工具分派 |
| D4 | 中 | 全部测试只 import `lib/`，改 `src/` 不构建就测不出行为回归；`check` 顺序又是「先测后构建」 | 复核者实测：只改 `src` → 84/84 全绿；改 `lib` 同一处 → 83/1 | `test` script 改为先 `build` 再测 |
| D5 | 低 | `suggest` 分支的 `pendingSuggestions` 在 `next()` 抛错时不清理 | 代码审读 | 加 `try/catch` 清理 |

修复后复跑：`ℹ tests 92 / pass 92 / fail 0`。

### 复核对本报告的两处纠正（已落进文档）

1. **「唯一接缝」的说法不完整。** 本报告此前只写「`tools/execute` 是唯一能改写命令的接缝」，**没有披露**官方 JSDoc 明确限定 wrapper「may change only `exec.signal`」。复核实测确认：改写能生效，只是因为执行对象直到 `notifyResult` 才被冻结——属于**未被支持的用法**，前向兼容无保证。这一披露现已写进 `README.md` 与 `README.zh.md` 的「注意」小节。
2. **「压缩结果永不大于原文」曾不成立**（D1）。本报告此前把它列为无条件不变量，属于**夸大**；现已改为带修复历史的准确表述。

### 复核确认成立的部分

改写确实只能经 `tools/execute`（复核者用真实 `ToolRuntime` + 3 路并发实测）、退出码标记在 bash 路径确实保住、rtk 缺失时正确退化、参数在 `finally` 中恢复、并行调用无串扰、`lib` 与 `src` 除 `.map` 外一致。

### 仍未覆盖

pwsh 真机执行、grep 超限时的真实会话 e2e、`/rtk` 命令面与 settings 命名空间冲突路径、`test-output`/`linter`/`search` 与 pi 版的逐行对照。

---

## 9. 超长输出：与 harness spill 的职责冲突（已修）

由 token 效率复核发现、我实测确认。

**事实**：`dsh-spill-policy` 确实挂载，`maxInlineBytes = 50000`；它把完整输出落盘、上下文只留头尾预览——**可恢复**。而 dsh-rtk 的硬截断**不可恢复**，且**先执行**。

**实测**：`seq 1 12000`（约 60 KB）→ 输出被砍在 2619 行（≈12000 字符，末尾 `2...`），**没有任何 spill 落盘路径**。因为 12000 < 50000，spill 永远等不到大输入。

**修复**：新增 `deferToHarnessSpill`（默认 `true`）。插件在 `apply` 时用 `ctx.get('spillStore')` 探测 spill 是否挂载；挂载则关闭自身的 `truncate`，把超大输出让给可恢复的 spill 路径；未挂载则保留截断作为唯一上限。

**为什么用显式开关而不是"用户是否设过 truncate"**：loader 传给 `apply` 的是 **schema 归一化后**的配置，每个字段都带默认值，"键不存在"与"显式设为默认值"无法区分。第一版据此判断，被测试当场抓出（协调永不生效）。显式开关语义清晰且可覆盖。

**未覆盖**：spill 真实触发路径未在会话内观察到（需要一次 >50000 字节且不被 rtk 改写的输出）；本项结论基于配置 + 截断行为的实测。

---

## 10. settings 命名空间静默失败（已修）

**症状**：`/rtk show` 打印 `config: settings service unavailable`；`settings.describe()` 里始终没有 `dsh-rtk`；所有 settings 编辑无效且**毫无提示**。

**根因**：同一份 `apply()` 里出现矛盾 —— `ctx.get('spillStore')` 成功（`truncate off` 证明协调生效），而 `ctx.get('settings')` 返回 `undefined`。服务不是不存在，而是**注册得晚**：settings provider 要先读设置文档。`inject` 当时只声明了 `tools`，插件在 settings 出现之前就已经 apply 过了。

**修复**：`inject = ['tools', 'settings']`。Cordis 对这个声明的语义正是「等待服务出现后再激活」。

**验证**（重启后）：`hasDshRtk=true`，namespace 总数 17 → 18，解析值 `readCompaction.enabled=true`、`smartTruncate={enabled:true,maxLines:220}`、`deferToHarnessSpill=true`，均与 patch 配置一致。

**一个容易误读的点**：settings 里 `truncate.enabled` 显示 `true`（schema 解析值），而实际行为是**关闭**的 —— 因为插件在运行时探测到 spill 后做了协调。`deferToHarnessSpill` 才是表达该意图的字段。

**注**：这个 bug 之所以能被找到，靠的是先前那次「让失败可见」的改动 —— 在此之前它是完全静默的。

---

## 11. settings 换代：dsh 0.1.7 兼容（2026-09-27）

日期：2026-09-27 · 环境：Node v26.7.0 · 新代：DSH 0.1.7-rc.2（本机全局 bun 安装）· 旧代对照：`@deepseek-ai/dsh-settings@0.1.5-rc.1`（npm 解包）

### 11.1 事实核对

| 断言 | 命令 | 实测输出 |
|---|---|---|
| 0.1.7 删掉了旧 settings API | 修复前 `tsc -p tsconfig.json --noEmit` | 4 条错误：`SettingsProvider`/`SettingsScope` 不再导出（TS2614）、`"settings/updated"` 不在 `keyof Events`（TS2345） |
| 新服务是 `SettingsForms`，方法面 describe/update/replace/mutate/configure | `rg "export declare class" node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts` | 只有 `SettingsForms`、`SettingsConflictError`；无 `register`/`get`/`watch` |
| 旧代确有 register + scope.watch/replace | npm 解包 `@deepseek-ai/dsh-settings@0.1.5-rc.1` 的 `lib/types/index.d.ts` | `SettingsScope<T>{ get(); watch(cb); update(patch); replace(section) }` |
| 新机制 = `.volatile()` 字段 + 原地提交 + `loader/volatile-update` | `rg "_commitVolatile\|loader/volatile-update" ~/.bun/install/global/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js` | `_commitVolatile` 用 `updateVolatile(ref, source)` 写进运行中的引用，随后 `emit("loader/volatile-update", paths)`（只发给所属 fiber） |
| `.volatile()` 是 3.18.4 才有的 API | `rg volatile` 对照 schemastery 3.18.2 / 3.18.4 | 3.18.2 无输出；3.18.4 有 `Schema.prototype.volatile` 与 `validateVolatileSchema` 路径规则 |
| 修复前在真宿主形状下**整个插件死亡** | 探针：用 SettingsForms 方法面假件调 `apply` | `apply 抛异常 → TypeError: settings.get is not a function` |
| 旧 peer 范围装不上新宿主 | `semver.satisfies('0.1.7-rc.2','^0.1.5-rc.1')` | `false`（prerelease 只配同 [major,minor,patch] 元组） |
| 设置条目 id = 组合行 id，不是插件名 | `SettingsForms.describe` 源码 `ns: entry.options.id` + 本机 `~/.dsh/cordis.patch.yml` | 本机行是 `- id: rtk` → 条目名 `rtk`（不再是 `dsh-rtk`） |
| 工具管线两代没变 | `rg "tools/(pre-)?execute\|tools/post-execute" dsh-tools/lib/types/index.d.ts` | 事件签名与 `PostToolDecision` 形状均未变；`spillStore` 服务也还在 |

### 11.2 验收标准表

| 标准 | 判定命令 | 期望输出 | 实测 |
|---|---|---|---|
| typecheck 干净 | `node --run typecheck` | 退出 0、无输出 | ✅ |
| 全量测试 | `node --run test` | `fail 0` | ✅ 130/130 |
| 未知 settings 形状不再弄死插件 | `node --test test/integration.test.ts`（`survives a settings service it does not recognize`） | 通过 | ✅ |
| 0.1.5 老轨行为不回归 | `test/settings-compat.test.ts` legacy 三例 + integration 的 `settings integration` | 通过 | ✅ |
| 0.1.7 新轨：读引用 / 监听变更 / reset 定位自己条目 | `test/settings-compat.test.ts` modern 三例 + integration 的 modern 两例 | 通过 | ✅ |
| 降级路径（未知代、构造期爆炸、reset 被拒、modern 面缺 replace） | `test/settings-compat.test.ts` unknown 两例 + `reports a refused reset` + `survives a modern surface without replace` | 通过 | ✅ |
| 真 schemastery 接受 volatile 标记并产出引用；`editable()` 两代降级 | `node --test test/schema-contract.test.ts` | 5/5 通过 | ✅ |
| 编译产物无 dsh-settings 运行时依赖 | `rg "from '@deepseek-ai/dsh-settings'" lib/` | 无输出（退出 1） | ✅ |
| 锁文件同 scope 单版本 | `rg -o "'?@(deepseek-ai)/(cordis\|schemastery\|cosmokit)@…" pnpm-lock.yaml \| sort -u` | 每包一个版本 | ✅ cordis 4.0.4 / schemastery 3.18.4 / cosmokit 1.8.5 |
| peer 范围两代都匹配 | `semver.satisfies(v, '^0.1.5-rc.1 \|\| ^0.1.7-rc.2')`，v ∈ 两代 | 都 true | ✅ 0.1.5-rc.1/0.1.5-rc.3/0.1.7-rc.2 全 true |

### 11.3 验红记录（修复前确实失败）

修复前（当时的 `lib/` 对着新宿主的服务形状）4 条新测试全红：

```
✖ survives a settings service it does not recognize
  AssertionError: Got unwanted exception. Actual message: "settings.get is not a function"
✖ survives an empty settings service object        （同上）
✖ observes live config edits committed into the running references
  TypeError: settings.get is not a function  at apply (lib/index.js:145)
✖ resets through the settings service, naming its own profile entry（同上）
```

修复后 4 条全部通过（连同双轨单测、schema 契约测试与独立复核后的补测，130 项全绿）。

### 11.4 不变量

| 不变量 | 怎么保证 | 验证 |
|---|---|---|
| 0.1.5 老宿主行为不变（注册 `dsh-rtk`、watch、replace、双实例跟随） | settings-compat 老轨原样保留旧行为 | fake provider 测试 ✅ |
| 工具管线行为不变（改写/压缩/通知/spill 协调） | 管线代码一行未动 | 130 项测试全绿 ✅ |
| 结果尾部 `[exit code: N]` 标记不被挤走 | `appendNotice` 未改 | 测试 ✅ |
| 编译产物不 import 任何会变的宿主包 | settings 面全部走结构化鸭子类型 | `rg "from '@deepseek-ai/dsh-settings'" lib/` 无输出 ✅ |
| `Config` 对两代 schemastery 都可加载 | `editable()` 特性探测 `.volatile()` | `test/schema-contract.test.ts` 的 `editable()` 两例 ✅ |

### 11.5 已知限制与部署发现

- **部署发现（0.1.7）**：组合行放在 home patch（`~/.dsh/cordis.patch.yml`）里时，设置页**只读**——服务拒绝会被低层覆盖的写（实测拒绝文案：`Configuration for "rtk" is overridden by a home patch or command-line overlay`）。行放在 **profile 层**则可写（11.6 第 6 轮实测 reset 成功）。本机当前是 home patch 部署，`/rtk reset` 与在线编辑会被如实拒绝；想调参就把行挪进 profile。
- 新代的设置条目名是**组合行 id**（本机是 `rtk`），不再是插件名 `dsh-rtk`。0.1.5 存量用户层里 `dsh-rtk` 段不会自动迁移（本机 `settings.yaml` 不存在，无实际影响）。
- peer 范围匹配不到「未来 rc 系」（如 `0.1.8-rc.1`）—— semver 的 prerelease 规则只认同 `[major,minor,patch]` 元组，每出一系 rc 需要一行范围更新（已写进 CHANGELOG）。
- legacy 轨对真 0.1.5 包的集成仍靠 fake + 旧类型面留痕（见 11.7）。

### 11.6 真宿主 e2e（隔离 DSH_HOME，2026-09-27 已做）

**做法**：独立 `DSH_HOME`（`.e2e/home`，不碰运行中的 GUI 宿主），拷贝 headless profile、换入 `pnpm pack` 的 0.1.1 构建、`.credentials.yaml`/`llm-deepseek`/`dsh-config-manager` 以**软链**复用（凭据不复制），`--patch` 挂 `id: rtk` 行 + 一个取证探针插件（把发现写进第一个 bash 结果）。`--dump-config` 干跑先证明两行被正确组合。共 6 轮 headless 一次性会话。

| 轮 | 配置 | 实测证据（会话日志原文） |
|---|---|---|
| 1 开通知 | `--patch` 行 + `showRewriteNotifications: true` | `[rtk] rewrote: git status -> rtk git status`；`git status` 经 rtk 执行（结果带 rtk 自己的 `[rtk] /!\\ No hook installed` stderr）；`seq 1 30000`（约 165KB）交给 harness spill 且**不双截断**（`deferToHarnessSpill` 协调生效，完整输出落 spill 文件） |
| 2 安静 | 同行、默认配置 | 改写照样发生（同样有 rtk stderr），但**没有** `[rtk] rewrote` 通知 —— 默认安静 ✓ |
| 3 对照 | **不挂** rtk 行，只留探针 | `git status` 原样输出（无任何 rtk 痕迹）；`hasRtkEntry=false hasRtkCommand=false` —— 「什么都没发生」也被断言 |
| 4 探针 v2 | `commands.execute('/rtk …')` | `THREW … reading 'session'`：宿主的命令执行先写 `command/run` 生命周期日志，探针不带会话上下文 —— 宿主机制，非插件问题 |
| 5 探针 v3 | `--patch` 行，直接调**注册到 registry 的 handler** | `rtkPath=the \`rtk\` entry in the harness settings document`；`rtkReset=dsh-rtk: reset was refused (Configuration for "rtk" is overridden by a home patch or command-line overlay) — edit the composition \`config:\` block instead.`（审计发现 1 的兜底当场立功：拒绝被如实报告，没有崩、没有假成功） |
| 6 探针 v3 | 行挪进 **profile 层** | `rtkReset=dsh-rtk: user overrides cleared — configuration is back to the composition's values.`（真 SettingsForms 上的现代 reset 成功路径）；reset 后 `enabled=true` 保留（composition 层不被抹） |

**探针还实测到**：`settingsEntries=…,rtk`（条目按组合行 id 命名 ✓，describe() 只列有 volatile 表单的条目 → 我们的 `.volatile()` 标记在真宿主生效 ✓）；`commands=…,rtk`（`/rtk` 注册成功 ✓）；`rtkValue.showRewriteNotifications` 随 patch 配置取值（true/false 两轮各验一次）。

**复现配方**（清理前的 `.e2e/` 已删；重跑照此）：`pnpm pack` → 建 `DSH_HOME`、profile 拷贝换入 tarball、软链凭据 → `--patch` 行 + 探针 → `dsh --profile e2e --patch … "用 bash 跑 …"` → `zstd -d` 会话日志取证。

