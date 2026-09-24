# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。

---

## 项目概述

Windows 平台「每应用音频路由」工具。Tauri v2 + React + TypeScript + TailwindCSS + Motion。

核心能力：枚举有音频会话的进程、枚举渲染设备、将**一个或多个（Ctrl+多选）进程**路由到一台或多台设备（多设备时第一台为主设备，其余通过进程回环复制，支持同步启动、按设备延迟补偿以对齐蓝牙、按设备音量以平衡响度）、自动记忆路由规则、两张列表随 Core Audio 变化实时更新、托盘常驻与开机自启。

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
│       ├── main.rs         # 入口，注册命令 + 窗口关闭拦截（托盘常驻）+ 显示看门狗
│       ├── commands.rs     # Tauri 命令（invoke handler）
│       ├── tray.rs         # 托盘图标 + 菜单（左键开关窗口；菜单标签由前端下发以跟随语言）
│       ├── autostart.rs    # 开机自启：直接读写 HKCU\...\Run，启动时带 --hidden
│       ├── audio/
│       │   ├── mod.rs
│       │   ├── devices.rs      # IMMDeviceEnumerator 设备枚举
│       │   ├── sessions.rs     # IAudioSessionEnumerator 会话枚举
│       │   ├── routing.rs      # IPolicyConfig 单设备路由设置
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
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/后台开关/延迟范围·步进·逐设备设置/关于）
│   │   ├── LogPanel.tsx
│   │   ├── TitleBar.tsx    # 自定义标题栏（无边框窗口，仅品牌 + 设置入口 + 窗口控制）
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
│   │   ├── useBackendEvent.ts # 后端事件订阅（StrictMode 安全的 token 交接），两个事件共用
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
7. **动画**：统一使用 Motion 组件，禁止手写 `@keyframes`（除非 Motion 无法实现）
8. **导入顺序**：React → 第三方 → 别名 → 相对路径，各组间空行

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
- 系统默认渲染设备由 `get_default_device` 取得并存入 `defaultDeviceId`；进程无可记忆路由时以它作为默认关联设备（选中进程即自动选中），进程列表每行显示该进程当前播放到的设备
- 路由记忆配置由 Rust 端持久化到 `app_data_dir/route-memory.json`（`config.rs`，exe -> 设备列表，兼容旧版单设备格式）
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
- 复制引擎通过后端事件 `duplication-stopped`（pid / reason / error）向前端同步状态
- 设备列表、进程列表由 store action 管理：后端 `audio-changed` 事件驱动自动同步（见下面「后台常驻与实时刷新」），手动 Refresh 按钮保留作兜底；**没有轮询定时器**

---

## 后台常驻与实时刷新（2.1 起，改动前必读）

### 托盘（`tray.rs`）

- 托盘图标**常驻**：左键开关窗口，右键菜单只有「显示/隐藏」和「退出」。`Quit` 走 `app.exit(0)`，是唯一会拆掉复制引擎的出口。
- 菜单标签是**原生控件**，读不到 i18next → 由前端在挂载和语言切换时调 `set_tray_labels(t('tray.show'), t('tray.quit'))` 下发。不要指望 Rust 侧自己翻译，也不要用 `set_menu()` 换整个菜单（换完托盘的事件路由就不再认那些条目）。
- `close_to_tray` 存在 `app_data_dir/app-settings.json`，**默认 false**：发版不该悄悄改掉老用户按 X 的语义。为 true 时 `main.rs` 的 `WindowEvent::CloseRequested` 里 `api.prevent_close()` + `hide()`。
- 这个判断在 **Rust**，所以设置必须在后端。**只有 Rust 需要知道的设置才进 `app-settings.json`**——主题/语言/步进仍然走 localStorage，别顺手搬过去。
- 新增 Tauri 命令**不需要**动 `capabilities/`：ACL 只管插件命令，`generate_handler!` 注册的应用自有命令默认可调（`apply_route` 等一直没有权限条目就是证据）。要改的是窗口按钮那类，见「安全注意事项」。

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

- 中心圆：当前选中进程，显示进程名 + 目标设备数（点击路由到选中的设备集合）；液态玻璃质感（accent 渐变 + 顶部高光 + 内圈描边），可路由时有呼吸光晕
- 中环：涟漪动画，路由操作时触发（双波纹）；慢速旋转装饰环含轨道点
- 音频流连线：中心到每个选中设备的虚线曲线（统一顺时针弧度），持续向外流动；已生效路由的连线更亮且带光晕
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
  - 点击名称按钮选中设备后要 `blur()`（仅指针点击，`e.detail > 0`）：否则按钮保持焦点，下一个 Space 会静默取消刚做的选择。
    键盘激活（`detail === 0`）必须保留焦点。
- 进程列表：已路由进程显示设备数徽标 + 停止路由按钮（✕）；选中高亮为跨条目滑动的共享胶囊（layoutId）；每行第二行是 `PID xxx · 当前播放设备`（同一行内，不要再单开一行显示设备）
- 舞台底部不放常驻面板：延迟在设备节点上改，其余设置都在设置页
- 激活状态：`scale(1.05)` + `box-shadow` 扩散
- 路由动画：spring stiffness=300, damping=20
- 视觉体系：液态玻璃（`--glass-*` tokens + backdrop-blur + shadow-glass），body 环境渐变 + App 内漂移光晕为玻璃提供"折射"色彩；所有微动效统一走 Motion，不手写 @keyframes

---

## CI/CD

- **触发**：push to `main` / tag `v*`
- **任务**：
  1. `pnpm install --frozen-lockfile`
  2. `pnpm tauri build`（构建 MSI）
  3. 上传 artifact
  4. 若为 tag，创建 GitHub Release 并附 MSI
- **环境**：`windows-latest`, Rust stable, Node LTS
- **版本号有五处字面量**：`package.json`、`tauri.conf.json`、`src-tauri/Cargo.toml`、`TitleBar.tsx` 的 `v2.1` 徽标、`SettingsPage.tsx` 关于卡片的 `v2.1.0`。少改一处就是 UI 在说谎；README 两份里的版本徽章/速查表也算，发版时一起看。

---

## 安全注意事项

- `capabilities/main.json` 只约束**插件命令**（`plugin:window|*`、`store:*`）：调它们之前先确认权限名与命令名对得上（`allow-toggle-maximize` ↔ `toggle_maximize`），失败会被前端吞成 `console.warn`。`generate_handler!` 注册的应用自有命令不受 ACL 约束，加命令不用改能力文件。
- 能力文件只有 `main.json` 一份：`tauri.conf.json` 的 `capabilities: ["main"]` 是**过滤器**，写了名字之后该目录下其它文件全部静默失效。改完必须 touch `build.rs` 才会重新编译进策略。
- 禁止在前端拼接 shell 命令
- Rust 端 COM 调用必须校验输入（device_id 格式、pid 范围）
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
- [ ] 自动记忆功能正常（重启后保留）
- [ ] 插上一个新设备 / 让一个新程序开始放音：不点 Refresh，两边列表自己跟上，且日志只在内容真的变化时多一行
- [ ] 托盘图标常驻，左键开关窗口；开启「关闭窗口时最小化到托盘」后按 X 不退出、路由继续
- [ ] 开启「开机自动启动」后：注册表 `HKCU\...\Run` 有那一条、重启后只出现托盘图标不弹窗、开关状态仍与注册表一致
- [ ] Light/Dark 切换流畅
- [ ] 同心圆动画流畅（60fps）
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
