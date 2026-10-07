# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。
> 本文件只保留**常驻规范与红线**；专题细节在 [docs/agents/](docs/agents/)，改到哪块先读哪篇（见下方索引）——里面的每条 ⚠️ 都是踩过的坑，改动前读，别凭印象删。

---

## 项目概述

Windows 平台「每应用音频路由」工具。Tauri v2 + React + TypeScript + TailwindCSS + Motion。

核心能力：枚举有音频会话的进程、枚举渲染设备、将**一个或多个（Ctrl+多选）进程**路由到一台或多台设备（多设备时第一台为主设备，其余通过进程回环复制，支持同步启动、按设备延迟补偿以对齐蓝牙、按设备音量以平衡响度），**把一个程序的输出送进另一个程序的输入（2.3.0 起）**，自动记忆路由与送入规则、两张列表随 Core Audio 变化实时更新、托盘常驻与开机自启、单实例（再次启动只唤出已有窗口）。

**硬性约束：无任何第三方 exe 依赖。** 所有音频操作由 Rust 直接调用 Windows Core Audio API。「送入程序」因此**不自带虚拟声卡**：它经回环驱动提供的一对端点（播放侧 + 录音侧）转接，端点对在设置页里由用户指定；未配置时送入规则照记，但保持静默并在看板上说明原因。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端 | React 19 + TypeScript (strict) |
| 样式 | TailwindCSS v3 (utility-first, CSS variables) |
| 动画 | Motion (`framer-motion`) |
| 构建 | Vite v6 |
| 包管理 | pnpm |
| Rust | edition 2021, `windows` crate (官方) |

---

## 专题文档索引（docs/agents/，按需读）

| 文档 | 什么时候读 |
|------|-----------|
| [state.md](docs/agents/state.md) | 改 `routerStore`、路由 / 送入 / 记忆 / 撤销、延迟、音量（份额 / 主输出 / 源电平）、显示名、图标 |
| [background.md](docs/agents/background.md) | 改托盘 / 单实例 / 自启 / 启动提示、`notifications.rs`、`duplication.rs`、`routing.rs`（端点分配） |
| [board-ui.md](docs/agents/board-ui.md) | 改 `NodeStage` / `ProgramRail` / `StatusBriefing` / `RoutedCapsule`、调音条、看板几何 |
| [theme.md](docs/agents/theme.md) | 改颜色、圆角、阴影、`Ring`、任何视觉与动效 |
| [acceptance.md](docs/agents/acceptance.md) | 发版前、或大改动后自查 |

---

## 目录结构

```
AppAudioRouter/
├── src-tauri/                # Rust 后端
│   ├── tauri.conf.json       # Tauri 配置 + capabilities（能力文件只有 main.json 一份）
│   └── src/
│       ├── main.rs             # 入口：注册命令 + 关闭拦截（托盘常驻）+ 显示看门狗 + 退出前交还端点分配
│       ├── commands.rs         # Tauri 命令（invoke handler）
│       ├── tray.rs             # 托盘图标 + 菜单（菜单标签由前端下发以跟随语言）
│       ├── autostart.rs        # 开机自启：HKCU\...\Run，启动带 --hidden
│       ├── install.rs          # 启动提示判定（建窗口之前）+ install-state.json
│       ├── single_instance.rs  # 单实例：命名互斥 + 命名事件（第二次启动唤出已有窗口）
│       ├── config.rs           # 配置持久化（app_data_dir 下各 json）：
│       │                       #   route-memory（exe→设备列表）/ device-delays / device-volumes（设备份额）/
│       │                       #   primary-volumes（主输出音量）/ source-volumes（源电平）/ feed-memory / feed-carrier /
│       │                       #   app-settings（close_to_tray 等 Rust 侧设置）
│       └── audio/
│           ├── devices.rs       # 设备枚举（渲染 + 捕获两个数据流共用走法）
│           ├── sessions.rs      # 会话枚举 + 显示名装配（窗口标题 → FileDescription）
│           ├── process_meta.rs  # 窗口标题 / FileDescription / 图标提取（按路径缓存命中，miss 不缓存）
│           ├── routing.rs       # 每应用端点槽 25/26 读写 + PinnedRoutes（渲染/捕获两本账）
│           ├── duplication.rs   # 进程回环 → 多设备复制引擎（源静默后停放）+ 每源电平估计与增益
│           ├── levels.rs        # 每源电平表（只回 1 秒内的读数）
│           └── notifications.rs # COM 通知线程 → audio-changed / session-activity 事件
├── src/                      # React 19 前端
│   ├── components/
│   │   ├── NodeStage.tsx           # 节点看板：路由唯一被表达的地方（hub/去向/来源三类卡 + Inspector 调音条）
│   │   ├── ProgramRail.tsx         # 左栏程序列表（行末圆形开关取代 Ctrl+点击）
│   │   ├── RoutedCapsule.tsx       # 「已路由 n」胶囊：所有路由的管理面（只有停止，没有开始）
│   │   ├── StatusBriefing.tsx      # 「直说」现状气泡（按需的路由大白话摘要）
│   │   ├── SourceLevelDial.tsx     # hub 卡下的每程序电平环（仅多设备路由挂载）
│   │   ├── Toast.tsx               # 瞬态提示：路由与送入的撤销入口（全项目唯一）
│   │   ├── SettingsPage.tsx        # 设置独立页面
│   │   ├── LogPanel.tsx            # 活动记录（下划线标签页第二页）
│   │   ├── TitleBar.tsx            # 自定义标题栏（透明；「已路由 · 播放中」计数 + 设置入口）
│   │   ├── StartupWizard.tsx       # 首次启动全屏向导（四步）
│   │   ├── StartupNoticeDialog.tsx # 升级提示弹窗（旧版本固定端点警告 + 就地重置）
│   │   └── ui/                     # Ring（同心圆，全项目一枚）/ ProcessIcon / Switch / UnderlineTabs /
│   │                               #   SegmentedControl / ScrubReadout / StepButton / Tooltip / ConfirmButton /
│   │                               #   DelayStepper / Spinner
│   ├── hooks/                # useTheme / useLanguage / useDelayValue / useLiveness（声流闸门）/ useBackendEvent
│   ├── stores/routerStore.ts # Zustand store
│   ├── i18n/                 # en.json + zh-CN.json（键集合有对称测试保护）
│   ├── lib/                  # invoke / delay / stage（看板几何）/ motion（共享动效曲线）/ icons /
│   │                         #   carrierDetect（回环驱动探测）/ productionGuards / types / window
│   └── styles/index.css      # Tailwind 入口 + CSS variables（色板唯一事实来源）
├── docs/agents/              # 专题规范（state / background / theme / board-ui / acceptance，按需读）
├── docs/images/              # README 截图
├── e2e/                      # Playwright E2E（假 Tauri IPC 桥 + README 截图脚本）
└── AGENTS.md                 # 本文件
```

---

## 代码规范

### TypeScript / React

1. **严格模式**：`tsconfig.json` 启用 `strict: true`、`noUncheckedIndexedAccess: true`
2. **类型导出**：所有公共类型必须显式 `export type`
3. **函数组件**：使用 `React.FC<Props>` 或普通函数签名，禁止使用 `any`
4. **Hooks 规则**：遵守 Rules of Hooks，不在条件/循环中调用
5. **命名**：
   - 组件：`PascalCase` (`ProgramRail.tsx`)
   - Hooks：`use` 前缀 (`useTheme.ts`)
   - 工具函数：`camelCase`
   - 常量：`SCREAMING_SNAKE_CASE`
   - 类型/接口：`PascalCase`，**不**加 `I` 前缀
6. **Tailwind**：优先 utility class，禁止自定义 CSS 类（除非通过 `@apply` 或 CSS variables）
7. **动画**：统一使用 Motion 组件，禁止手写 `@keyframes`（除非 Motion 无法实现）。spring 与时长一律取 `lib/motion.ts` 的四条共享曲线——`SPRING_TAP`（微交互）/ `SPRING_GLIDE`（有位移的元素）/ `SPRING_ROUTE`（路由动作本身）/ `FADE`（纯透明度），**不要在调用点现调参数**：邻居之间弹得不一样看着像 bug，不像设计。`main.tsx` 的 `MotionConfig reducedMotion="user"` 已全局跟随系统「减少动态效果」，新增动画不必各自判断。
8. **动效只用来报告状态**：动画要说明一件正在发生的事（视图切换、下划线迁移、现状气泡浮出、路由已生效、程序正在出声），纯装饰的无限循环一律不加。
   ⚠️ **凡是动 opacity/transform 的 motion 元素一律挂 `MAIN_THREAD_TRANSFORM`**（`lib/motion.ts`，恒等 `transformTemplate`）——**入场和退场都算，tween 和弹簧都算**。
   Motion 的 WAAPI 路径在动画结束的那一帧先同步拆掉动画、批量样式提交却晚一帧，元素会闪回内联基态：退场的眨一下眼、纯入场的在落定那一刻整块闪没一帧再回来（从设置页切回看板时整页闪就是这个）。别以为弹簧安全：framer 11 的弹簧经 `linear()` 缓动同样上 WAAPI。主线程动画每帧都提交内联样式，没有旧值可回落；纯 layout 动画（`layoutId` 迁移）与 SVG 不必挂。
9. **常驻循环只有两个，且都必须被闸门看住**：看板线上的流动虚线、同心圆环的脉冲（报告同一件事：正在出声）。2026-10-01 删掉过一批装饰循环（背景漂移光晕、80s 轨道环、设备脉冲环），这两层后来被请了回来——除此之外一个循环都不许有。闸门（`useLiveness`）是硬约束：窗口不可见、失去焦点、或系统要求减少动效时，这两层都**卸载**（不是暂停）——静止的界面不产生任何重绘。一个后台窗口里每帧重算的滤镜与重绘，代价落在 WebView2 的 GPU 进程上。
   ⚠️ **新加一处脉冲或流动时，别忘了把它也接到 `useLiveness`**——它是 hook 而不是 CSS，不经由那道闸就等于没有。`reducedMotion="user"` 管的是入场与交互动画，与常驻循环不重叠。
10. **导入顺序**：React → 第三方 → 别名 → 相对路径，各组间空行

### Rust

1. **Edition**：2021
2. **错误处理**：使用 `thiserror` 定义错误类型，命令返回 `Result<T, String>`
3. **命名**：`snake_case`（函数/变量）、`PascalCase`（类型）、`SCREAMING_SNAKE_CASE`（常量）
4. **COM 安全**：所有 COM 调用封装在 `unsafe` 块中，外层提供安全抽象
5. **日志**：使用 `log` crate（`info!`, `warn!`, `error!`），不 `println!`
6. **注释**：所有 `pub` 项必须有 `///` doc comment；`unsafe` 块必须有 `// SAFETY:` 注释

### 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`feat` / `fix` / `refactor`（无行为变化）/ `style` / `docs` / `chore` / `perf` / `test`。

**禁止一次提交堆积大量文件。** 每个提交聚焦单一变更，控制在合理 diff 范围内。

---

## 红线速查

每条都对应一次真实的回归或被否掉的设计；理由与细节在括号里的专题文档，**拿不准就先读那篇**。

**身份与归属**（[state.md](docs/agents/state.md)）
- 所有键按 **exe**：路由、记忆、源电平、端点、图标。显示名只是显示层——不进任何键、不进 `sessionSignature`，`exe_path` 永不出 Rust。
- 一个 exe 只路由一个进程（取最小 pid）。**渲染与捕获是两个数据流**：`PinnedRoutes` 两本账，`stop_route` 只清渲染侧（并把挂起的送入就地钉回载体）；只有「重置每应用音频输出」与退出会两流一起清。
- 送入与设备路由是两类：记忆两份互不依赖；送入选中即生效（两端钉死，没有两段式计划）。
- 上报类结构（`ActiveRoute.device_ids` / `latency_ms`）一律平行数组、等长同序。

**端点分配**（[background.md](docs/agents/background.md)）
- 写端点的路径必须三步闭环：**写 → 登记 `PinnedRoutes` → 停止时归还**；四条归还路径（停止 / 退出 / 清扫 / 重置）缺一不可。
- 槽 27 `ClearAll...` **禁止使用**；清除后必须读回校验，Windows 拒绝时要报出仍固定在哪台设备，不许假装成功。
- 系统关键进程只在 `set_process_default_device` 入口拦截，别开第二条 COM 写入路径。

**刷新与引擎**（[background.md](docs/agents/background.md)）
- **全项目没有轮询定时器**：列表靠 `audio-changed`（COM 回调）；对齐是一次性动作；延迟读数靠 `reconcileActiveDuplications()` 在事件点重建——**每条新起引擎的路径都要跟一次**。
- **COM 指针只能活在通知线程**（MTA 独占，禁止 `unsafe impl Send`）。
- 源静默后**停放**镜像客户端，不许退回「一直写静音」（风扇投诉的来源）；新增停放点必须在被唤醒侧接 `wake()`；每处等待都要能说出自己是被什么唤醒的。

**音量与延迟**（[state.md](docs/agents/state.md)）
- 两个音量轴不许混：**设备份额**（副本响度，只能衰减）≠ **主输出音量**（会话音量 5–100，停止/退出时归还原值）。禁止绕过 `update_primary_volume` 写会话音量、给未路由的程序调会话音量、拿会话音量做设备间平衡。
- 控件按角色出现，结构说了算：主输出没有延迟行、单设备路由没有任何控件，「变淡地画」也算违规；`lib/engineRole.ts` 已删，别搬回来。
- 成对字面量改一处必须改另一处：`SOURCE_LEVEL_MAX`(TS) ↔ `SOURCE_VOLUME_MAX`(Rust)、`PRIMARY_VOLUME_MIN` 前后端。

**记忆与撤销**（[state.md](docs/agents/state.md)）
- 撤销是一个快照不是栈；记忆跟着撤销走（重路由用原 `remember` 标志，`stopRoute` 清记忆）。
- 自动恢复「一个 pid 只试一次」的 Set **故意不按存活清理**；`restoreRememberedRoutes` 必须排在 `releaseStaleRoutes` 之后。

**看板与前端**（[board-ui.md](docs/agents/board-ui.md)）
- 路由只由看板表达，别在别处画第二份（树 / 状态条 / 常驻文字摘要）；现状气泡是按需例外。
- 看板几何唯一来源 `lib/stage.ts`（组件用 `style` 取值，不用 Tailwind `w-[…]`）；没有拖动、平移、缩放。
- 已删不复活：液态玻璃、自由画布、路由树、设备表格、同心圆舞台（[board-ui.md](docs/agents/board-ui.md) 有完整清单）；`tauri-plugin-*` 见「安全注意事项」。

---

## CI/CD

- **触发**：push to `main` / tag `v*`；`pnpm install --frozen-lockfile` → `pnpm tauri build`（MSI）→ 上传 artifact → tag 时创建 GitHub Release。环境：`windows-latest`, Rust stable, Node LTS。
- **版本号有三处字面量**：`package.json`、`tauri.conf.json`、`src-tauri/Cargo.toml`（锁文件跟着走）。UI 显示的版本来自 `vite.config.ts` 注入的 `__APP_VERSION__`——取自 `package.json`，所以前端没有第二处要改；两份 README 里的版本徽章/速查表也算，发版时一起看。

---

## 安全注意事项

- `capabilities/main.json` 里那几条 `core:window:allow-*` 约束的是**核心命令**。本项目**不带任何 Tauri 插件**：`tauri-plugin-store` / `@tauri-apps/plugin-store` 与 `@tauri-apps/plugin-shell` 从头到尾没人调用，已于 2026-09-29 连同 `store:default` 权限一并移除——设置全部走自有的 `app-settings.json` 或 localStorage，别再为了"以后可能用"加回来。新增权限时先确认权限名与前端调用对得上（`allow-toggle-maximize` ↔ `toggleMaximize`），对不上会被前端吞成一条 `console.warn`。`generate_handler!` 注册的应用自有命令不受 ACL 约束，加命令不用改能力文件。
- 能力文件只有 `main.json` 一份：`tauri.conf.json` 的 `capabilities: ["main"]` 是**过滤器**，写了名字之后该目录下其它文件全部静默失效。改完必须 touch `build.rs` 才会重新编译进策略。
- 禁止在前端拼接 shell 命令
- Rust 端 COM 调用必须校验输入（device_id 格式、pid 范围）
- 每应用端点分配的清除只走槽 25 的 null HSTRING（单进程）；槽 27 的 `ClearAll...` 会连用户手设的一起清，禁止使用
- 系统关键进程的路由必须在 `audio::routing::set_process_default_device` 被拒（`is_protected_process`），别在别处另开写入路径
- 配置文件写入路径限定在 `app_data_dir`，禁止写任意路径
- 开机自启是本项目唯一写注册表的地方，且只写 `HKCU`（当前用户）的 `Run` 值、只改自己的 `AppAudioRouter` 条目：不碰 `HKLM`，不需要管理员权限
- 前端永不传 URL：`open_carrier_download` 只收驱动 key，URL 映射固定在 Rust 侧（`commands.rs` 的 `CARRIER_PAGES`），页面经 `ShellExecuteW` 的 open 动词交给浏览器关联

---

## 开发命令

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm tauri dev

# 类型检查
pnpm tsc --noEmit

# 构建
pnpm tauri build

# 单测（Vitest）
pnpm test

# E2E（Playwright，假 Tauri IPC；跑之前先起 `pnpm dev --port 1420`）
pnpm test:e2e

# 重拍 README 的两张截图（按需要手动跑，平时会被 skip）
# 输出 docs/images/app-audio-router-{light,dark}.png，900×680 @2x
# 画面由 e2e/tauri/bridge.ts 的脚本化音频图驱动，所以换机器也一致
CAPTURE_SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts

# Rust 检查
cd src-tauri && cargo check

# Rust 格式化
cd src-tauri && cargo fmt -- --check

# Rust lint
cd src-tauri && cargo clippy -- -D warnings
```
