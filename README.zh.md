# dsh-rtk

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的 RTK 命令重写 + 工具输出压缩插件。

`dsh-rtk` 会在 `bash` 命令执行前把它改写成等价的 [rtk](https://github.com/rtk-ai/rtk) 命令，并在工具输出进入模型上下文前压缩它。它是 [`pi-rtk-optimizer`](https://github.com/MasuRii/pi-rtk-optimizer) 在 harness 插件模型上的移植。

```
模型发出：  git status
实际执行：  rtk git status
模型看到：  Branch: main
            Modified: 2 files
              src/a.ts
```

## 功能

### 命令重写

- 有 rtk 等价命令的调用会在派发前被改写；rtk 不支持的命令原样执行。
- **rtk 始终是唯一事实来源。** 插件不带自己的重写表，而是通过 `rtk rewrite` 询问已安装的二进制，所以支持范围跟随你装的 rtk 版本。
- **`rewrite` 与 `suggest` 两种模式。** `rewrite` 替换命令；`suggest` 原样执行并报告本可使用的等价命令。
- **运行时守卫。** `guardWhenRtkMissing`（默认开）下，无法确认 rtk 可用的调用会执行原命令——缺少优化器永远不会挡住工作。
- 被改写的命令会带上隔离的 `RTK_DB_PATH`，rtk 的使用历史不会落进工作目录。

### 输出压缩

针对 `bash`、`read`、`grep` 结果的多阶段管线：

| 阶段 | 作用 |
|---|---|
| ANSI 剥离 | 去掉终端颜色与格式转义序列 |
| 构建过滤 | 提取编译错误与警告，丢弃进度噪音 |
| 测试聚合 | 折叠为 通过/失败/跳过 计数加失败摘录 |
| Git 压缩 | 归纳 `git status`、`git diff`、`git log` |
| Linter 聚合 | 统计问题数并按规则与文件排名 |
| 搜索分组 | 按文件归组 `grep` 风格匹配 |
| 源码过滤 | `none` / `minimal` / `aggressive` 注释与空白处理（默认关） |
| 智能截断 | 丢行时保留签名与 import（默认关） |
| 硬截断 | 最终字符预算 |

有两条性质是**硬性不变量**：

- **harness 的结果契约必须存活。** `bash` 结果以状态标记结尾——`[exit code: N]`、`[stderr]`、`[timed out after …]`、`[sandbox: …]`。压缩会先把这些标记摘出来，重写正文后再原样接回；模型被要求在每次调用后检查 `[exit code: N]`，Web UI 也解析同一行来画退出状态。

- **压缩绝不把结果变大。** 如果某个技术不能真正缩短文本，就保留原文并且不上报。

### 会话统计

`/rtk stats` 报告本次会话省下多少字符，按工具与按技术两个维度。

## 安装

### 1. 让包可被解析

装进 profile：

```bash
dsh plugin --profile web add /path/to/dsh-rtk
```

或者软链到组合能解析裸模块名的位置：

```bash
ln -s /path/to/dsh-rtk ~/.dsh/node_modules/dsh-rtk
```

### 2. 给一个 agent preset 加一行

`dsh-rtk` 是 **agent 平面**的行：它只往工具管线里注册监听器、不发布任何服务，所以不需要 `isolate` realm。把它加到你希望被优化的 preset：

```yaml
- id: rtk
  name: 'dsh-rtk'
  config:
    enabled: true
    mode: rewrite
```

不想动现有 preset，就复制一个再加行：

```
# 让 cordis preset 的 agent 执行
agentPresets.copy('standard', 'rtk', 'RTK 优化')
```

这一行挂在 **host 平面**同样有效（写进 `~/.dsh/cordis.patch.yml`），会覆盖该部署下的所有会话——但需要重启宿主，而且 host 行与 preset 行会同时想要同一个进程级 settings 命名空间。**两个平面只选一个。**

## 配置

所有字段可选，下列为默认值。

```yaml
- id: rtk
  name: 'dsh-rtk'
  config:
    enabled: true                    # 总开关
    mode: rewrite                    # rewrite | suggest
    guardWhenRtkMissing: true        # rtk 不可用时执行原命令
    showRewriteNotifications: false  # 在结果末尾附加一行改写说明
    rtkExecutable: rtk               # 名字或绝对路径
    rewriteTimeoutMs: 3000           # 单次 `rtk rewrite` 的截止时间
    compactedTools: [bash, read, grep]
    outputCompaction:
      enabled: true
      stripAnsi: true
      readCompaction:
        enabled: false               # 有损 read 压缩；默认关，保证读到的代码是精确的
      sourceCodeFilteringEnabled: false
      preserveExactSkillReads: false
      sourceCodeFiltering: none      # none | minimal | aggressive
      aggregateTestOutput: true
      filterBuildOutput: true
      compactGitOutput: true
      aggregateLinterOutput: true
      groupSearchOutput: true
      trackSavings: true
      smartTruncate:
        enabled: false
        maxLines: 220                # 40–4000
      truncate:
        enabled: true
        maxChars: 12000              # 1000–200000
```

配置同时注册为 harness 设置文档里的 `dsh-rtk` 命名空间，可以在那里编辑并即时生效、无需重启。组合里的 `config:` 块提供 `base` 层，设置文档在其上叠加用户层。

> **为什么 `readCompaction` 默认关。** 过滤或截断 `read` 结果，可能让模型拿到的文本与文件不再一致，编辑就会失配。默认开启的每一项，要么对它归纳的正文是无损的，要么只作用于整个形态都会被替换掉的输出。

## 命令

| 命令 | 说明 |
|---|---|
| `/rtk` | 显示配置与运行时状态 |
| `/rtk show` | 同 `/rtk` |
| `/rtk path` | 配置存放位置 |
| `/rtk verify` | 检查 rtk 可执行文件是否可用 |
| `/rtk stats` | 本次会话的压缩收益 |
| `/rtk clear-stats` | 重置收益计数 |
| `/rtk reset` | 恢复配置默认值 |
| `/rtk help` | 用法说明 |

## 工作原理

两部分都挂在工具管线上，而不是包装某个工具，因为 harness 恰好提供两个合适的接缝：

- **重写走 `tools/execute`。** `tools/pre-execute` 被刻意设计为不能修改参数——参数在派发前就已记入日志并呈现，在那里改写会让记录下来的调用与实际执行的不一致。around-dispatch 阶段是唯一能让「执行的命令」与「记录的命令」不同的地方，而 `dsh-rtk` 把改动限制在单次调用内：派发一返回就恢复原始参数，后续管线阶段与会话日志看到的仍是模型发出的调用。

- **压缩走 `tools/post-execute`**，这是允许替换结果内容的阶段。

两个监听器都注册在该行被挂载的 scope 里。因此 preset 行恰好覆盖它自己的 agent（preset 的 standing scope 是每个加入它的会话的祖先），而 host 行覆盖进程内所有 agent。

硬依赖只有 `tools` 服务。`settings`、`commands`、`systemPrompt` 都用 `ctx.get` 解析，缺少其中任何一个的组合仍然能获得优化。

### 注意：改写所用的接缝不是官方扩展点

harness 对 `tools/execute` wrapper 的文档原话是「may change only `exec.signal`」。替换 `arguments` **不是受支持的扩展点**——它能生效，只是因为执行对象要等到结果被通知时才被冻结。而失败的替代方案更糟：`tools/pre-execute` 被刻意设计为不能重写输入（参数在派发前就已记入日志并呈现），同一 layer 内也无法用新工具覆盖已有工具。

`dsh-rtk` 是**知情地**用了这条接缝，并在力所能及处做了对冲：替换只作用于单次调用、在 `finally` 里恢复，任何失败路径都退回模型发出的原命令。若未来的 harness 提前冻结执行对象，改写会**静默失效**而不是报错——命令按原样执行，压缩不受影响，因为 `tools/post-execute` 是**有文档记载的内容替换阶段**。

## 与 pi-rtk-optimizer 的差异

| pi-rtk-optimizer | dsh-rtk |
|---|---|
| 在 `tool_call` 钩子里改 `event.input.command` | 在一次派发期间替换 `exec.arguments`，随后恢复 |
| 在 `tool_result` 钩子里压缩 | 在 `tools/post-execute` waterfall 里压缩 |
| `/rtk` 打开 TUI 设置面板 | `/rtk` 输出文本状态；配置存在 harness 设置文档里 |
| 配置是它自己管的 JSON 文件 | 配置是 harness 设置命名空间，叠加在组合的 `config:` 块之上 |
| 通过 `tool_execution_*` 钩子清洗流式输出 | harness 没有对应钩子，故不清洗流式输出 |
| Windows 专用 shell 修正 | 未移植；目标部署是 POSIX |

其余部分——把重写委托给 `rtk rewrite`、退出码契约、rtk 缺失时的守卫、每个压缩开关的默认值、以及各项技术的算法——都是原样移植。

## 开发

```bash
pnpm run typecheck    # 用真实 harness 类型跑 tsc --noEmit
pnpm test             # 先构建，再跑 node --test test/
pnpm run build        # 产出 lib/
pnpm run check        # typecheck + test
```

测试 import 的是 `lib/`，所以 `pnpm test` 会先构建；否则只改 `src/` 而没构建的回归会静默通过。

`test/integration.test.ts` 用替身上下文驱动真实的 `apply()`，并调用真实的 `rtk` 二进制，所以在没装 rtk 的机器上会失败——这是有意的：重写路径就是这个功能本身。

## 许可证

MIT
