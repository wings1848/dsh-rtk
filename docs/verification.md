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
| 5 | 从 preset 目录可解析裸模块名 | `cd ~/.dsh/.agent-presets/rtk && node -e "import('dsh-rtk')"` | 解析成功，`name=rtk`、`inject=['tools']` | PASS |
| 6 | preset 能被真实组合引擎挂载 | 动态插件调用 `agentPresets.standingKeyFor('rtk')` | `MOUNT OK` | PASS |
| 7 | host patch 语法正确并被组合 | `dsh --profile web --dump-config \| grep -A3 "id: rtk"` | 组合树中出现 `- id: rtk / name: dsh-rtk` | PASS（该方案随后按第 5 节回滚） |
| 8 | bash 真被改写（端到端） | 在**新建**的、preset 选 `rtk` 的会话中运行 `ls -la` | 输出为 rtk 紧凑格式 | **待新会话确认**——同会话内切换被 harness 拒绝，见第 6 节 |

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

处置：**回滚 host patch，只保留 preset 方案**。理由：preset 是架构上正确的平面（agent 行为属于单个会话），而且新建会话即生效、无需重启宿主。回滚后重新 mount，结果：

```
[rtk-diag] rtkNamespaceRegistered=false namespaces=[...] MOUNT OK; key=[object Object]
```

`rtkNamespaceRegistered=false` 同时反证了 host 行从未真正激活（`ls` 也一直是原生格式），因此上述冲突来自首次失败的 mount 残留，而非 host 行。

---

## 6. 端到端验证（在同一会话内无法完成，附证据）

曾尝试把**正在运行的会话**重挂到 `rtk` preset，以便在进程内取到端到端证据。`agentPresets.select` 明确拒绝：

```
[rtk-switch] SELECT FAIL: session "session-44856891-97cb-44d9-a8ab-ea4691871430" has already started; its agent preset is fixed
```

**preset 在会话创建时锁定**，这是 harness 的设计约束，不是实现缺陷。`SubagentStartRequest` 也没有 preset 覆盖字段（只有 `label`/`prompt`/`parent`/`signal`/`agentOptions`），所以 subagent 同样继承父会话的 preset，无法用来验证。

因此第 8 项只能由**新建会话**完成。可复现步骤：

1. 在 Web GUI 新建一个会话，preset 选 `rtk`（磁盘上已就绪：`~/.dsh/.agent-presets/rtk/agent.cordis.yml`）。
2. 运行 `ls -la`。若 dsh-rtk 生效，实际执行的是 `rtk ls -la`，输出为 rtk 的紧凑格式（无权限位/owner/日期列）。
3. 运行 `/rtk verify` 应报告 rtk 可用；运行 `/rtk stats` 应报告本次会话的压缩收益。
4. 对照：在同一会话里运行 `echo hi`（rtk 无等价命令）应原样执行。

**已就位的前置证据**：`rtk` preset 已通过真实组合引擎的 mount 验证（`MOUNT OK`），模块名从 preset 目录可解析，且 `apply()` 的全部接线与真实 rtk 二进制的交互已由 92 项测试覆盖。

---

## 7. 已知限制

- **流式 bash 输出未清洗。** Pi 有 `tool_execution_start/update/end` 钩子可以边流边清洗；harness 没有对应事件，故未移植。
- **Windows 兼容修正与 hashline 锚点保护的 read 处理未移植。** 目标部署是 POSIX，且 harness 的 `read` 输出格式与 Pi 不同（read 压缩默认关闭，影响面为零）。
- **`/rtk` 没有交互式设置面板。** harness 的 TUI 设置面板是 client 侧能力；配置改由 `dsh-rtk` settings 命名空间承载，可用 `/rtk show` 查看、在设置文档中修改。
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
