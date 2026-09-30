# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。

---

## 项目概述

Windows 平台「每应用音频路由」工具。Tauri v2 + React + TypeScript + TailwindCSS + Motion。

核心能力：枚举有音频会话的进程、枚举渲染设备、将**一个或多个（Ctrl+多选）进程**路由到一台或多台设备（多设备时第一台为主设备，其余通过进程回环复制，支持同步启动、按设备延迟补偿以对齐蓝牙、按设备音量以平衡响度）、自动记忆路由规则、两张列表随 Core Audio 变化实时更新、托盘常驻与开机自启、单实例（再次启动只唤出已有窗口）。

**硬性约束：无任何第三方 exe 依赖。** 所有音频操作由 Rust 直接调用 Windows Core Audio API。

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

## 目录结构

```
AppAudioRouter/
├── src-tauri/              # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json     # Tauri 配置 + capabilities
│   └── src/
│       ├── main.rs         # 入口，注册命令 + 窗口关闭拦截（托盘常驻）+ 显示看门狗 + 退出前交还端点分配
│       ├── commands.rs     # Tauri 命令（invoke handler）
│       ├── tray.rs         # 托盘图标 + 菜单（左键开关窗口；菜单标签由前端下发以跟随语言）
│       ├── autostart.rs    # 开机自启：直接读写 HKCU\...\Run，启动时带 --hidden
│       ├── install.rs      # 启动提示：全新安装 / 装过旧版本（建窗口之前判定，install-state.json 记版本）
│       ├── single_instance.rs  # 单实例：命名互斥 + 命名事件（第二次启动唤出已有窗口后自行退出）
│       ├── audio/
│       │   ├── mod.rs
│       │   ├── devices.rs      # IMMDeviceEnumerator 设备枚举
│       │   ├── sessions.rs     # IAudioSessionEnumerator 会话枚举
│       │   ├── routing.rs      # 每应用端点：槽 25/26 写入·释放·读回（null HSTRING = 清除）+ 系统关键进程拦截 + PinnedRoutes（本进程写过的分配，停止/退出/重置时归还）
│       │   ├── duplication.rs  # WASAPI 进程回环 → 多设备复制引擎
│       │   └── notifications.rs # 变更通知线程 → audio-changed 事件（设备/会话实时刷新）
│       └── config.rs       # 配置持久化（route-memory.json: exe -> 设备列表；device-delays.json: 设备 -> 延迟补偿 ms + delay_range_ms 正负范围上限；device-volumes.json: 设备 -> 音量 %；app-settings.json: close_to_tray）
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── ConcentricRouter.tsx  # 同心圆路由核心组件（设备节点 + 节点下方的延迟/音量标注）
│   │   ├── DeviceAnnotation.tsx  # 挂在设备节点下方的一行标注（延迟 + 音量），顺带管显隐与 hairline 引线
│   │   ├── ProcessList.tsx
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/已记忆路由列表/每应用音频重置/后台开关/延迟范围·步进·逐设备设置/关于）
│   │   ├── LogPanel.tsx
│   │   ├── TitleBar.tsx    # 自定义标题栏（无边框窗口，仅品牌 + 设置入口 + 窗口控制）
│   │   ├── StartupNoticeDialog.tsx  # 启动提示弹窗（欢迎语 / 旧版本提示 + 就地重置）
│   │   └── ui/             # 基础控件
│   │       ├── Switch.tsx              # 动画开关
│   │       ├── SegmentedControl.tsx    # 滑动胶囊分段控件
│   │       ├── ScrubReadout.tsx        # 通用「数值即控件」（拖动/滚轮/方向键/键入），延迟与音量共用
│   │       ├── DelayReadout.tsx        # 延迟读数：签名毫秒 + 步进/范围，套 ScrubReadout
│   │       ├── VolumeReadout.tsx       # 音量读数：百分比 0–100，套 ScrubReadout
│   │       ├── StepButton.tsx          # 圆形 ± 按钮（仅设置页在用）
│   │       └── DelayStepper.tsx        # 设置页的延迟行控件（−/数值/+ 方框样式）
│   ├── hooks/              # 自定义 hooks
│   │   ├── useTheme.ts
│   │   ├── useLanguage.ts
│   │   ├── useDelayValue.ts  # 延迟编辑状态（草稿/提交/步进），两个延迟控件共用
│   │   ├── useBackendEvent.ts # 后端事件订阅（StrictMode 安全的 token 交接），三个事件共用
│   │   ├── useDecorativeMotion.ts # 装饰性循环该不该跑（窗口可见 + 有焦点 + 未要求减少动效）
│   │   └── useFitScale.ts  # 适配缩放（同心圆舞台）
│   ├── stores/             # 状态管理
│   │   └── routerStore.ts  # Zustand store
│   ├── i18n/               # 国际化
│   │   ├── index.ts
│   │   ├── i18next.d.ts
│   │   └── locales/
│   │       ├── en.json
│   │       └── zh-CN.json
│   ├── lib/                # 工具函数
│   │   ├── invoke.ts       # Tauri invoke 封装
│   │   ├── delay.ts        # 延迟步进/钳制/范围换算
│   │   ├── motion.ts       # 全局共享动效曲线（tap / glide / route / fade）
│   │   ├── types.ts        # 共享类型定义
│   │   └── window.ts       # 窗口控制（懒加载 Tauri API）
│   └── styles/
│       └── index.css       # Tailwind 入口 + CSS variables
├── .github/workflows/      # CI/CD
│   └── release.yml
├── AGENTS.md               # 本文件
├── package.json
├── vite.config.ts
├── tsconfig.json
└── tailwind.config.ts
```

---

## 代码规范

### TypeScript / React

1. **严格模式**：`tsconfig.json` 启用 `strict: true`、`noUncheckedIndexedAccess: true`
2. **类型导出**：所有公共类型必须显式 `export type`
3. **函数组件**：使用 `React.FC<Props>` 或普通函数签名，禁止使用 `any`
4. **Hooks 规则**：遵守 Rules of Hooks，不在条件/循环中调用
5. **命名**：
   - 组件：`PascalCase` (`ProcessList.tsx`)
   - Hooks：`use` 前缀 (`useTheme.ts`)
   - 工具函数：`camelCase`
   - 常量：`SCREAMING_SNAKE_CASE`
   - 类型/接口：`PascalCase`，**不**加 `I` 前缀
6. **Tailwind**：优先 utility class，禁止自定义 CSS 类（除非通过 `@apply` 或 CSS variables）
7. **动画**：统一使用 Motion 组件，禁止手写 `@keyframes`（除非 Motion 无法实现）。spring 与时长一律取 `lib/motion.ts` 的四条共享曲线——`SPRING_TAP`（微交互）/ `SPRING_GLIDE`（有位移的元素）/ `SPRING_ROUTE`（路由动作本身）/ `FADE`（纯透明度），**不要在调用点现调参数**：邻居之间弹得不一样看着像 bug，不像设计。`main.tsx` 的 `MotionConfig reducedMotion="user"` 已全局跟随系统「减少动态效果」，新增动画不必各自判断。
8. **动效只用来报告状态**：常驻的循环动画要有含义（已生效的路由在流动、可路由时中心圆呼吸），纯装饰的无限循环会被砍掉——日志面板那颗心跳点就是因为一直在眼角闪而改成静止的。
9. **没人看的时候循环要停**：剩下的装饰性循环（背景漂移光晕、80s 轨道环、设备脉冲环、已生效连线的流动虚线）统一由 `useDecorativeMotion()` 把关——窗口不可见、失去焦点、或系统要求减少动效时冻结成一帧静止状态，而不是继续重绘。一个后台窗口里的 backdrop-blur + 滤镜每帧重算，代价落在 WebView2 的 GPU 进程上，而任务管理器里那一条没人会算到这个程序头上。**动效层面的 `matchMedia` / `visibilitychange` 判断只此一处**，不要在组件里各写一份（`useTheme` 读 `prefers-color-scheme` 是配色的事，与此无关）。`reducedMotion="user"`（见上条）管的是入场与交互动画，这条管的是常驻循环，两者不重叠、都要留。
10. **导入顺序**：React → 第三方 → 别名 → 相对路径，各组间空行

### Rust

1. **Edition**：2021
2. **错误处理**：使用 `thiserror` 定义错误类型，命令返回 `Result<T, String>`
3. **命名**：`snake_case`（函数/变量）、`PascalCase`（类型）、`SCREAMING_SNAKE_CASE`（常量）
4. **COM 安全**：所有 COM 调用封装在 `unsafe` 块中，外层提供安全抽象
5. **日志**：使用 `log` crate（`info!`, `warn!`, `error!`），不 `println!`
6. **注释**：所有 `pub` 项必须有 `///` doc comment；`unsafe` 块必须有 `// SAFETY:` 注释

### 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

| 类型 | 用途 |
|------|------|
| `feat` | 新功能 |
| `fix` | 修复 |
| `refactor` | 重构（无行为变化） |
| `style` | 格式/样式 |
| `docs` | 文档 |
| `chore` | 构建/工具 |
| `perf` | 性能优化 |
| `test` | 测试 |

**禁止一次提交堆积大量文件。** 每个提交聚焦单一变更，控制在合理 diff 范围内。

---

## 状态管理

- 前端使用 Zustand store（`stores/routerStore.ts`）集中管理设备、进程、选中状态、日志
- 进程选择是有序集合（`selectedPids`）：单击单选，Ctrl+点击多选；一次路由操作应用到全部选中进程
- 路由选择是有序集合（`selectedDeviceIds`）：第一个为主设备，其余为复制目标
- 选中一个进程会**预填**目标设备（`deviceSelectionPrefilled`：当前路由 → 系统默认设备），这是程序自己的猜测，不是用户的选择：这一状态下第一次点另一台设备是**替换**（"改成只输出这一台"）并留一行 `deviceSwitched` 日志，之后才恢复追加/取消的语义。2.1.1 修的就是这里——以前"换个设备"会变成两台一起响，声音出现在用户正想离开的那台设备上。
- 系统默认渲染设备由 `get_default_device` 取得并存入 `defaultDeviceId`；进程无可记忆路由时以它作为默认关联设备（选中进程即自动选中），进程列表每行显示该进程当前播放到的设备
- 路由记忆配置由 Rust 端持久化到 `app_data_dir/route-memory.json`（`config.rs`，exe -> 设备列表，兼容旧版单设备格式）
- **记忆的路由会自动恢复**（`restoreRememberedRoutes`）：`autoRemember` 开关存 localStorage（`aar-auto-remember`），
  开启时进程一出现在会话列表里就按 exe 名把记忆的路由写回去。规则：
  - **每个 exe 只路由一个进程**（取最小 pid）：音频服务按可执行文件存这条分配，一个浏览器十几个进程只需要一条路由，不需要十几个复制引擎。
  - 已拔掉的设备从目标里剔除，全没了就整条跳过；`devices` 为空时直接返回——启动时设备/进程/记忆三份数据到达顺序不定，
    所以 `refreshDevices` / `refreshSessions` / `loadRememberedRoutes` **三处都调它**，谁最后到谁生效。
  - `autoRestoreDecided`（模块级 Set）保证一个 pid 只尝试一次：用户手动停掉的路由不能被下一次刷新装回去，
    失败的恢复也不该在每次 Core Audio 通知时重试并刷日志。**这个 Set 故意不按存活进程清理**——pid 从列表消失恰恰是不该重试的情形。
  - 恢复必须排在 `releaseStaleRoutes` **之后**（`refreshSessions` 里用 `swept.then(...)` 串起来）：
    两者都会碰同一个 exe 的分配记录，并发时清扫可能赢，把刚写好的路由又清掉。
  - 设置页「已记忆的路由」列出这些 exe，✕ 调 `clear_route` 忘记。程序替用户做了决定，就得能在同一个地方撤回。
- 延迟是**每台设备各自相对系统音频的绝对值**（不是相对某台主设备）：每台设备都可设，主设备（系统直连那台）也能设；
  `duplication.rs` 以「组内延迟最小的设备」为基准，`target_frames()` = 基础 100ms `LATENCY_TARGET_MS` + (自身延迟 − 组内最小值)，
  所以相对差一定被精确还原、绝对值会被归一化到最早的那台（软件延迟只能加不能减）。组内最小值同时包含主设备的值（`primary_delay_ms`）。
- 应用路由时前端按延迟从小到大排序（`orderByDelay`），让延迟最小的设备成为系统直连的主设备；设置页可调 ±1/2/5/10 秒范围与步进（默认 10 ms，`aar-delay-step`），缩小范围时前后端同时钳制越界值。
- 延迟入口在**设备节点胶囊下方**（`DeviceAnnotation` 里的 `DelayReadout`，绝对定位，不参与胶囊布局）：
  hairline 引线 + 签名数值 + 小号 `ms`，**没有任何 ± 按钮**，胶囊本身只写设备名。
  横向拖动按配置步进连续调节（4px 一步），滚轮 / 方向键步进（Shift 十倍），点击键入精确值。
  拖动期间只更新本地预览、松手一次性提交（一次手势只留一条日志）；步进与键入即时提交。
  零值渲染为弱化色，非零或交互中才用 accent。标注显隐规则：**选中 或 延迟≠0**
  （后者保证舞台不会隐藏一个已生效的偏移）。
  **胶囊宽度恒定**——悬停/编辑都不改变任何宽度（历史上那套「胶囊内嵌步进器 + 悬停展开」的方案已废弃，不要再复活）。
  不要在舞台底部再做常驻面板。`delaySync` 关闭时该读数变淡并提示「延迟同步已关闭」；
  设置页仍保留逐设备列表（`DelayStepper`，−/数值/+），便于给未选中的设备预设延迟。
- 音量按设备持久化到 `app_data_dir/device-volumes.json`（`config.rs`，设备 -> %）。值与延迟同构：**以组内最响的一台为基准**，
  `duplication.rs` 的 `group_max_volume()` 取组内（含主设备）最大值，镜像按 `own / max` 在 `pump_render` 写设备**之前**缩放采样的增益；
  软件增益只能衰减，所以最响的那台无法被压低，只能作为基准，其余设备向它对齐。0 表示静音，100 表示原样（不落盘）。
  采样格式在 `start()` 时从 `WAVEFORMATEX`(可能 extensible) 解析成 `SampleFormat`（float32/float64/PCM 16·24·32），
  认不出的格式**跳过增益**而不是乱改数据；增益为 1.0 时直接短路，常规情况不付任何代价。
  **不要**再回到「按 exe 压会话音量」那套（`ISimpleAudioVolume` / `set_session_volume` / session-volumes.json 已于 2026-09-19 整体移除）。
  前端读数 `VolumeReadout` 挂在胶囊下方的标注行里（延迟右侧，1px 竖 hairline 分隔），同样套 `ScrubReadout`：
  0–100、固定步进 5%、3px 一步；tooltip 说明「相对同组最响的一台衰减」。进程列表里那个按程序的音量滑杆已随之删除。
- 两个读数都靠 `EngineRole`（`mirror` / `primary` / `inactive`）说明**这个值此刻到底生不生效**，因为改得动不等于改了就有效：
  - `mirror` = 引擎在驱动这台设备，值直接生效；
  - `primary` = 系统直连播放，软件既加不了延迟也压不了音量，它的值只作为整组的基准，所以提示里要写明"只影响对齐参考 / 只作为响度基准"；
  - `inactive` = 没有任何引擎路径涉及它（未路由，或是单设备路由——单设备根本不启动引擎），此时读数**变淡**并提示原因。
  `ConcentricRouter` 从 `routedPids` 推导角色，**跳过长度 < 2 的路由**（单设备路由没有引擎），且 `mirror` 优先于 `primary`——一台设备同时是某条路由的镜像和另一条的基准时，它的值是在生效的。
  提示的优先级是"最具体的原因先赢"：同步关闭 > 未生效 > 主设备基准。**不要**给单设备路由也照常显示一个看起来很有效的数值：用户会以为调了有用。
- 复制引擎通过后端事件 `duplication-stopped`（pid / reason / error）向前端同步状态
- **单个镜像失败走自己的事件，不并进 `duplication-stopped`**：`duplication.rs` 的 `fail_mirror()` 发 `duplication-mirror-failed`（pid / generation / deviceId / error），引擎继续为其余设备播放。前端 `handleMirrorFailed` 用与引擎级事件**同一套 generation 守卫**（过期的镜像不得改动已经被替换掉的路由），再把该设备从 `routedPids[pid]` 里摘掉并写一条 error 日志点名它。
  修的是这个观感问题：以前只 `warn!` 到 release 会丢弃的 stderr，界面上整条路由看起来完整生效，但有一台设备根本没声音——和"程序坏了"没法区分。**不要把它并回 `duplication-stopped`**：那条会拆掉整个引擎，而这里其余设备还在正常出声。
- `stop_route` 返回 `StopOutcome`（`released` / `pinned_device`）：没释放成功时前端写一条 error 日志点名那台设备，而不是报"已恢复系统默认"；设置页的「重置每应用音频输出」、以及 `refreshSessions` 发现被路由的 pid 消失后调用的 `releaseStaleRoutes()`，都归到同一套端点归还逻辑（见下面「每应用端点分配的生命周期」）
- 设备列表、进程列表由 store action 管理：后端 `audio-changed` 事件驱动自动同步（见下面「后台常驻与实时刷新」），手动 Refresh 按钮保留作兜底；**没有轮询定时器**

---

## 后台常驻与实时刷新（2.1 起，改动前必读）

### 托盘（`tray.rs`）

- 托盘图标**常驻**：左键开关窗口，右键菜单只有「显示/隐藏」和「退出」。`Quit` 走 `app.exit(0)`，是唯一会拆掉复制引擎的出口；退出都会经过 `RunEvent::ExitRequested`，在那里交还本进程写过的端点分配（见「每应用端点分配的生命周期」）。
- 菜单标签是**原生控件**，读不到 i18next → 由前端在挂载和语言切换时调 `set_tray_labels(t('tray.show'), t('tray.quit'))` 下发。不要指望 Rust 侧自己翻译，也不要用 `set_menu()` 换整个菜单（换完托盘的事件路由就不再认那些条目）。
- `close_to_tray` 存在 `app_data_dir/app-settings.json`，**默认 false**：发版不该悄悄改掉老用户按 X 的语义。为 true 时 `main.rs` 的 `WindowEvent::CloseRequested` 里 `api.prevent_close()` + `hide()`。
- 这个判断在 **Rust**，所以设置必须在后端。**只有 Rust 需要知道的设置才进 `app-settings.json`**——主题/语言/步进仍然走 localStorage，别顺手搬过去。
- 新增 Tauri 命令**不需要**动 `capabilities/`：ACL 只管插件命令，`generate_handler!` 注册的应用自有命令默认可调（`apply_route` 等一直没有权限条目就是证据）。要改的是窗口按钮那类，见「安全注意事项」。

### 单实例（`single_instance.rs`）

第二个实例会和第一个抢配置文件与音频设备，而后面每一步都假设自己独占这两样。

- 两个内核对象：`Local\AppAudioRouter.SingleInstance` 命名互斥判"是否已经在运行"，`Local\AppAudioRouter.ShowWindow` 命名事件让第二次启动**请求已有窗口显示出来**。用 `Local\` 是因为它是每个登录会话一份，RDP 的另一个会话各跑一个互不干扰——音频引擎本来就是按会话走的。
- 守卫在 `setup()` 里**最先**执行（读配置、建托盘、起通知线程之前），拿不到互斥就 `app.handle().exit(0)` 并直接返回：第二次启动不能碰任何配置或音频状态。返回的 guard 交给 `app.manage()` 持有到进程结束。
- 第二次启动的语义是"把窗口叫出来"，不是"没反应"——托盘常驻的应用没有别的答案。第一个实例的 watcher 线程等到事件后调 `tray::reveal()`。
- 事件**先于**互斥创建：`CreateEventW` 是按名字打开已有对象的，所以和第一个实例抢跑的那次启动依然唤得到同一个对象。判定依据是 `CreateMutexW` 成功但 `GetLastError() == ERROR_ALREADY_EXISTS`（`Ok` 路径不会动 getLastError，所以这里可靠）。
- 创建互斥失败只 `warn!` 并**以无守卫方式继续启动**：单实例是防打架，不是安全边界，绝不能因为一个内核对象建不出来就拒绝启动。
- 手写而不用 `tauri-plugin-single-instance`，理由与 `autostart` 同款：插件为一次 `CreateMutexW` 带来一对需要版本锁步的 npm/Cargo 依赖。**不要把插件加回来。**

### 开机自启（`autostart.rs`）

- 直接写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `AppAudioRouter` 值，命令行固定带 `--hidden`。**不引入 `tauri-plugin-autostart`**：那要多一个 npm 包、一条 capability 和一次版本锁步（CLI 会因 Cargo/npm 的 minor 不一致直接拒打包），而插件干的也就是同一次注册表写入。
- `get_autostart` 读注册表而不是配置文件：注册表是唯一真相，用户在任务管理器里删掉启动项，开关必须跟着变。
- 每次启动调 `repair_if_drifted()`：已注册但路径与当前 exe 不一致（安装目录被移动过）就重写。开机静默失败比报错难查得多。
- `--hidden` 的语义有**两处**消费者：`main.rs` 跳过显示看门狗，前端 `isSilentLaunch()` 为真时不调 `revealMainWindow()`。只改一边就会出现「开机弹窗口」或「开机后再也打不开」。

### 实时刷新（`audio/notifications.rs`）

- 设备/进程列表由后端事件 `audio-changed`（`{ devices: bool, sessions: bool }`）驱动，仍然**没有轮询**——注册的是 COM 回调，不是定时器。
- ⚠️ **COM 指针只能活在通知线程里**。windows-rs 0.58 的接口既不是 `Send` 也不是 `Sync`：本模块用「一个 MTA 线程独占所有指针，回调只往 `mpsc` 丢一条消息」来避免 `unsafe impl Send`。想把 `IMMDeviceEnumerator`/`IAudioSessionNotification` 塞进 `app.manage()` 之前先想起这条。
- 三种回调缺一不可：`IMMNotificationClient`（端点增删/默认切换/属性变化）、`IAudioSessionNotification`（**只报新建**）、`IAudioSessionEvents::OnStateChanged(Expired)`（会话消亡）。少了最后一种，进程列表会永远留着早就停止播放的程序。`Inactive`（暂停但会话还在）**不能**当成退出处理，否则暂停一下就从列表消失。
- 线程启动时必须先 `sync()` 一次：两种回调都只报「变化」，不给已存在的设备/会话预先挂钩子，启动前就在放音的程序永远不会被通知到。
- 一次热插拔会连着发好几个回调（added → default → state → property）。合并在两处做：**后端** drain `rx.try_recv()` 成一批，**前端** 用 `AUDIO_SYNC_DEBOUNCE_MS = 400` 合并 flags（用 `||` 累积，别覆盖，否则会丢掉前一次的一半）。
- 通知触发的刷新是 `refreshDevices(true)` / `refreshSessions(true)`：**只有列表内容真的变了才写日志**（`devicesChanged` / `sessionsChanged`），手动的照旧固定写一行。注意 `refreshSessions` 的可选参数——点击处理器必须 `() => void refreshSessions()`，直接把函数交给 `onClick` 会把 MouseEvent 当成 `true` 传进去。
- 注册失败只 `warn!`，绝不致命：列表退化成手动刷新，窗口必须照常打开。

### 每应用端点分配的生命周期（2.1.1 起，改动前必读）

路由期间 `routing.rs` 写下的不是一条"临时路由"，而是音频服务为**可执行文件**保存的一条 Per-app 默认端点记录：程序退出、本应用退出、乃至卸载之后它都还在，并且**优先于系统默认设备**。2.1.0 的「停止路由」是把这条记录改写成当时的默认设备再留在那儿，于是用户之后手动切默认设备对这个程序失效（现场表现就是"停止之后就切不了播放设备了"）。规则：

- 写入 = 槽 25 `SetPersistedDefaultAudioEndpoint`；同槽传 **null HSTRING 即清除这条记录**（音量合成器里的「默认」走的就是同一条路）；槽 26 `GetPersistedDefaultAudioEndpoint` 读回，没有记录时返回 `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)` = `0x80070490`。槽 27 的 `ClearAllPersistedApplicationDefaultEndpoints` **禁止使用**：它会连用户在音量合成器里手设的分配一起清掉。
- **任何写端点的路径都必须登记 `PinnedRoutes`**：`mark` = 活路由（重置/清扫要放过它），`mark_returned` = 停止时 Windows 拒绝释放、于是把它指回当前默认设备的（重置**必须**能清掉它，否则用户只剩"重启应用"这一条路）。登记是唯一能把"我们钉的""用户自己钉的""已经不算路由的"三者分开的东西。
- 归属判定**按可执行文件、不按单个 pid**：分配是按 exe 存的，而一个程序可以有多个带会话的进程（浏览器就是），清扫时挑中的 pid 未必是我们路由的那个。清理前要问"这个 exe 是否还有属于我们的活路由"，问"这个 pid 是不是我们的"会漏。
- 清除后必须**读回校验**（`release_default_endpoints` 已这么做），并把结果回给前端；Windows 拒绝时要报出仍固定在哪台设备，不许假装成功。
- 四条归还路径缺一不可，各自覆盖一种"分配比路由活得久"的情形：停止路由（`stop_route`）、退出应用（`main.rs` 的 `RunEvent::ExitRequested` → `release_pinned_blocking`，独立线程 + 有界等待，绝不能让音频服务卡住退出）、程序在路由期间退出后下次出声（`release_stale_routes`；音频服务按 pid 寻址，所以只能借它新的进程去释放）、设置页「重置每应用音频输出」（`reset_pinned_endpoints`，清旧版本留下的，跳过仍在路由的 pid）。
- 新增任何"改变某程序输出"的代码路径，都要把这一套接上：写 → 登记 → 停止时归还。少一步就是把用户锁在错误的设备上，而且界面上没有任何东西能解释为什么。
- 系统关键进程在 `set_process_default_device` 入口被 `is_protected_process` 拒绝（`PROTECTED_EXES` + pid 0/4），两份 README 都承诺过这件事——不要绕过这个入口另开 COM 写入路径。

### 启动提示（`install.rs`，2.1.1 起）

首次启动和升级后的首次启动各要说一句话：全新安装给两行欢迎语，装过旧版本则在弹窗里直接提供「重置每应用音频输出」。旧版本可能在 Windows 里留下固定端点（见上一节），而应用分不出「旧版本留下的」和「用户在音量合成器里手设的」——所以既不静默清理，也不装作没事，而是问一次。

- ⚠️ **判定必须在建窗口之前完成**（`main.rs` 里 `tauri::Builder` 之前），依据是本应用自己的两个目录：`%APPDATA%\<identifier>`（配置文件，只有存过东西才存在）和 `%LOCALAPPDATA%\<identifier>\EBWebView`（WebView2 档案，任何版本跑过一次就有）。挪进 `setup()` 就晚了：这一次启动自己会建出 EBWebView，全新安装会被认成升级。
- 目录取自环境变量而不是 `app.path()`，因为判定时机在 App 存在之前；`identifier` 从 `generate_context!().config()` 读，别手抄字面量（会和 `tauri.conf.json` 漂移）。
- 「上次运行的版本」记在 `app_data_dir/install-state.json`，**在用户点掉提示时写**（`ack_startup_notice`），所以同一版本只提示一次、下次升级会再提示。写失败只记日志，不能让提示卡在那里。
- `StartupNotice { kind, previous_version }` 的 `kind`（kebab-case）是前后端契约，`src/lib/types.ts` 的联合类型按字面量认它，`install.rs` 里有测试钉住；新增第三种之前先想清楚前端怎么显示。
- 弹窗里那个重置按钮复用 `resetPinnedEndpoints`，不要再写一条清理路径；文案必须写明「会清掉当前正在运行的程序」，否则用户会以为它只清旧版本留下的东西。

---

## 主题系统

- 使用 CSS variables 定义色板
- `darkMode: 'class'` 策略
- 主题切换通过 `document.documentElement.classList.toggle('dark')`
- 持久化用户偏好到 `localStorage` + 跟随系统初始值
- 色板为青色（cyan）信号色，不用靛紫/紫罗兰；改色时 `:root` / `.dark` 两份定义、`--accent-rgb` 镜像通道与 `--ambient-*` 环境光必须一起改

```css
:root {
  --bg-primary: #fafafa;
  --bg-secondary: #f3f3f5;
  --bg-tertiary: #e8e8ec;
  --text-primary: #18181b;
  --text-secondary: #3f3f46;
  --text-muted: #71717a;
  --accent: #0891b2;
  --accent-hover: #0e7490;
  --accent-muted: rgba(8, 145, 178, 0.12);
  --accent-glow: rgba(8, 145, 178, 0.32);
  --border: #e4e4e7;
  --success: #10b981;
  --error: #ef4444;
}
.dark {
  --bg-primary: #09090b;
  --bg-secondary: #18181b;
  --bg-tertiary: #27272a;
  --text-primary: #fafafa;
  --text-secondary: #d4d4d8;
  --text-muted: #a1a1aa;
  --accent: #22d3ee;
  --accent-hover: #06b6d4;
  --accent-muted: rgba(34, 211, 238, 0.14);
  --accent-glow: rgba(34, 211, 238, 0.28);
  --border: #27272a;
  --success: #34d399;
  --error: #f87171;
}
```

---

## 同心圆 UI 规范

- 中心圆：当前选中进程，显示进程名 + 目标设备数（点击路由到选中的设备集合）；液态玻璃质感（accent 渐变 + 顶部高光 + 内圈描边），可路由时有呼吸光晕；`applying` 期间按钮禁用并降到 70% 不透明度 + `cursor-progress`（禁用了却毫无变化看着像坏了）
- 中环：涟漪动画，路由操作时触发（单道柔波）；慢速旋转装饰环含轨道点（80s 一圈，是舞台上唯一的常驻装饰动效，窗口没人看时冻结——见「代码规范 · 动画」第 9 条）
- 音频流连线：中心到每个选中设备的虚线曲线（统一顺时针弧度）。**虚线只在路由已生效时流动**——选中但未路由的连线是静止的，动的那条才代表音频真的在走；已生效的连线更亮更粗，下面垫一条同色的模糊 halo（`<filter>` 在 `<defs>` 里，只作用于这条静止的 halo）。不要给会动的虚线路径挂 `drop-shadow`：滤镜会跟着每一帧重算
- 外环：设备列表（**多选**），每个设备为一个玻璃胶囊节点
  - 第 1 个选中设备 = 主设备（实心 accent 徽标 "1"）
  - 其余选中设备 = 复制目标（描边样式 + 序号徽标）
  - 已在当前路由中的设备带 success 圆点 + 扩散脉冲光环
  - 系统默认播放设备在节点右下角带一个 muted 小圆点（title 提示）
  - 延迟与音量**挂在胶囊下方**（`DeviceAnnotation` 里排一行，绝对定位）：hairline 引线 + 两个读数（`+180 ms  │  60 %`）——
    胶囊本身只写设备名，一个设备仍然是一个对象，不要另起气泡/面板。两者都是**数值即控件**（`ScrubReadout`）：拖动/滚轮/方向键/键入，没有 ± 按钮。
  - **长度自适应，但只有一个上限**：胶囊宽度由内容决定，设备名 `min-w-0 truncate` 占它需要的宽度；
    上限是推导值而不是像素预算：`MAX_NODE_WIDTH = 2 × (CENTER − ORBIT_RADIUS)`（=132px，轨道水平极端的节点到舞台边缘的余量），
    以 inline style `style={{ maxWidth: MAX_NODE_WIDTH }}` 下发。这个额度**只属于设备名**（标注在胶囊外，不参与）。
    **悬停/编辑不改变任何宽度**——这是「延迟占满了」事故之后定下的铁律：不要复活任何「悬停让胶囊变宽」的设计。
    **不要再给名字设 `max-w-[42px]` 这类像素预算**——会得到忽长忽短的胶囊。
  - 标注行绝对定位在 `top-full` 居中处，宽度随数值自然变化也**不会推动任何东西**；
    每个读数各自的悬停反馈是一根 `absolute` hairline 下划线（`group/scrub`），不占宽度。两个读数之间的分隔用 1px 竖 hairline。
  - 标注显隐：**选中 或 该读数非中性**（延迟≠0 / 音量<100）——已生效的偏移绝不能被藏起来，没动的设备也不该无谓地占视觉。
    读数另按 `EngineRole` 变淡并在 tooltip 里说明"当前未生效"的原因（单设备路由没有引擎、主设备只作基准），见「状态管理」。
  - 点击名称按钮选中设备后要 `blur()`（仅指针点击，`e.detail > 0`）：否则按钮保持焦点，下一个 Space 会静默取消刚做的选择。
    键盘激活（`detail === 0`）必须保留焦点。
- 进程列表：已路由进程显示设备数徽标 + 停止路由按钮（✕）；选中高亮为跨条目滑动的共享胶囊（layoutId）；未选中的行悬停才有 `bg-bg-tertiary/40` 浅底——已选中的行不加，免得盖住那颗胶囊；每行第二行是 `PID xxx · 当前播放设备`（同一行内，不要再单开一行显示设备）
  - 列表顶部有搜索框：`query` 是**组件本地 `useState`**，不进 store（它是视图状态，不是应用状态）；按 `exe_name` 过滤（`display_name` 已被后端移除，别再引用），`Escape` 清空并失焦。
  - 已路由的进程**排到最前**：按 `routedPids` 长度做**稳定**排序，让组内保持枚举顺序——否则行会在每次刷新时互相换位，鼠标底下的目标就跑了。
  - 无匹配时显示 `processList.noMatch`，**不要**复用 `processList.empty`：「没有进程在放音」和「你的搜索词没匹配上」是两件事，后者提示"让程序发声"是答非所问。
- 舞台底部不放常驻面板：延迟在设备节点上改，其余设置都在设置页
- 激活状态：`scale(1.05)` + `box-shadow` 扩散
- 路由动画：`SPRING_ROUTE`（spring stiffness=300, damping=20），中心圆的悬停/按下走这条；其余动效一律取 `lib/motion.ts` 的共享曲线（见「代码规范 · 动画」）
- 视觉体系：液态玻璃（`--glass-*` tokens + backdrop-blur + shadow-glass），body 环境渐变 + App 内漂移光晕为玻璃提供"折射"色彩；所有微动效统一走 Motion，不手写 @keyframes
- 漂移光晕、脉冲环、流动虚线、轨道环这几处循环全部由 `useDecorativeMotion()` 把关（见「代码规范 · 动画」第 9 条）：窗口不可见或失焦时**冻结成静止一帧**。冻结时光晕**保留颜色**只停位移——玻璃面板的"折射"观感靠的就是那点色，停掉动画不该让整块背景变灰

---

## CI/CD

- **触发**：push to `main` / tag `v*`
- **任务**：
  1. `pnpm install --frozen-lockfile`
  2. `pnpm tauri build`（构建 MSI）
  3. 上传 artifact
  4. 若为 tag，创建 GitHub Release 并附 MSI
- **环境**：`windows-latest`, Rust stable, Node LTS
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

# Rust 检查
cd src-tauri && cargo check

# Rust 格式化
cd src-tauri && cargo fmt -- --check

# Rust lint
cd src-tauri && cargo clippy -- -D warnings
```

---

## 验收清单

- [ ] `pnpm tauri dev` 启动无报错
- [ ] 进程列表正确显示有音频会话的进程
- [ ] 设备列表正确显示渲染设备
- [ ] 路由操作成功（进程音频切换到目标设备）
- [ ] 停止路由后程序跟随系统默认设备：之后手动切换默认输出，它也一起走（2.1.1 的回归点）
- [ ] 路由期间直接退出应用：程序不再被固定在旧设备上
- [ ] 设置 →「重置每应用音频输出」能清掉旧版本留下的固定记录，且不动正在路由的进程
- [ ] 启动提示：装过旧版本的机器第一次打开弹「检测到你装过旧版本」且能就地重置；全新安装弹欢迎语；点掉后同一版本不再弹（版本记在 `install-state.json`）
- [ ] 选中一个进程后点击另一台设备：只输出到那一台，不再两台一起响
- [ ] 自动记忆：开启后路由一个程序，重启本应用或让该程序重新出声，路由自动恢复且日志各留一行；手动停止过的不会被装回去；设置页能列出并「忘记」某条记忆
- [ ] 插上一个新设备 / 让一个新程序开始放音：不点 Refresh，两边列表自己跟上，且日志只在内容真的变化时多一行
- [ ] 托盘图标常驻，左键开关窗口；开启「关闭窗口时最小化到托盘」后按 X 不退出、路由继续
- [ ] 开启「开机自动启动」后：注册表 `HKCU\...\Run` 有那一条、重启后只出现托盘图标不弹窗、开关状态仍与注册表一致
- [ ] 单实例：程序已经在运行时再次启动它，只把已有窗口唤到前台，不出现第二个托盘图标，也不重复起一份复制引擎
- [ ] 进程列表搜索：输入即时过滤，已路由的排在最前且组内顺序稳定；`Escape` 清空并失焦；无匹配时的提示与「没有进程在放音」不是同一句
- [ ] 镜像设备失败：让一台正在镜像的设备打不开，该设备从路由徽标里消失并留一行点名它的 error 日志，其余设备继续出声
- [ ] 延迟/音量的生效提示：单设备路由时读数变淡并说明不生效；主设备的提示写明它只作基准
- [ ] 窗口失焦或最小化后舞台上的循环动效停住（GPU 占用回落），窗口恢复后又动起来
- [ ] Light/Dark 切换流畅
- [ ] 同心圆动画流畅（60fps）
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
