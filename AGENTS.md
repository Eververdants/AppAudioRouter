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
│       │   ├── duplication.rs  # WASAPI 进程回环 → 多设备复制引擎（源静默后停放；见「引擎的唤醒成本」）+ 每源电平估计与增益
│       │   ├── levels.rs       # 每源电平表：各引擎写自己的估算，对齐与诊断都从这里读（只回 1 秒内的读数）
│       │   └── notifications.rs # 变更通知线程 → audio-changed 事件（设备/会话实时刷新）
│       └── config.rs       # 配置持久化（route-memory.json: exe -> 设备列表；device-delays.json: 设备 -> 延迟补偿 ms + delay_range_ms 正负范围上限；device-volumes.json: 设备 -> 音量 %；source-volumes.json: exe -> 电平 %（可 >100）；app-settings.json: close_to_tray）
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── RouteCanvas.tsx       # 路由画布，也是路由唯一被表达的地方：一个源节点 + 每台设备一个节点，连线就是这条路由。源节点在左、设备在右，节点顺序由路由顺序决定（在路由里的排在最前）
│   │   ├── SourceNode.tsx        # 源节点：当前选中的程序，输出端口是三环同心圆（扇出点）
│   │   ├── DeviceNode.tsx        # 设备节点：名称按钮 + 角色词 +（高级）延迟/音量；端口是同心双环，卡片悬停轻微放大
│   │   ├── EdgeLayer.tsx         # 连线层：一张 svg 画完所有贝塞尔曲线，静态不动
│   │   ├── RouteConfirmCapsule.tsx # 悬浮确认胶囊：源 → 目标 + 取消/路由，浮在工作区底部，不占布局
│   │   ├── Toast.tsx             # 瞬态提示：路由后提供「撤销」（全项目唯一的撤销入口）
│   │   ├── ProcessList.tsx
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/已记忆路由列表/每应用音频重置/后台开关/延迟范围·步进·逐设备设置/关于）
│   │   ├── LogPanel.tsx          # 活动记录（下划线标签页的第二页）
│   │   ├── TitleBar.tsx    # 自定义标题栏（无边框窗口，仅品牌 + 设置入口 + 窗口控制）
│   │   ├── StartupNoticeDialog.tsx  # 启动提示弹窗（欢迎语 / 旧版本提示 + 就地重置）
│   │   └── ui/             # 基础控件
│   │       ├── Switch.tsx              # 开关（h-5 w-9）
│   │       ├── UnderlineTabs.tsx       # 下划线标签页（无胶囊；下划线用 layoutId 迁移）
│   │       ├── SegmentedControl.tsx    # 下划线式分段控件（不是胶囊，也不是 pill track）
│   │       ├── ScrubReadout.tsx        # 通用「数值即控件」（拖动/滚轮/方向键/键入），延迟与音量共用
│   │       ├── DelayReadout.tsx        # 延迟读数：签名毫秒 + 步进/范围，套 ScrubReadout
│   │       ├── VolumeReadout.tsx       # 音量读数：百分比 0–100，套 ScrubReadout
│   │       ├── StepButton.tsx          # 方形 ± 按钮（h-6 w-6，仅设置页在用）
│   │       ├── ConfirmButton.tsx       # 二次确认按钮（先「确认？」再执行；Escape/失焦/超时解除）
│   │       ├── DelayStepper.tsx        # 设置页的延迟行控件（−/数值/+ 方框样式）
│   │       └── NodePort.tsx            # 同心圆端口：外环 + 内芯，中间那圈透出节点自己的底色；dormant 变体是没有插线的另一侧
│   ├── hooks/              # 自定义 hooks
│   │   ├── useTheme.ts
│   │   ├── useLanguage.ts
│   │   ├── useDelayValue.ts  # 延迟编辑状态（草稿/提交/步进），两个延迟控件共用
│   │   └── useBackendEvent.ts # 后端事件订阅（StrictMode 安全的 token 交接），三个事件共用
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
│   │   ├── canvas.ts       # 画布：节点几何常量（连线由这些数算出来，不测量）+ 四种角色各自的配色类名 + 贝塞尔路径函数
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
8. **动效只用来报告状态**：动画要说明一件正在发生的事（视图切换、下划线迁移、胶囊浮出、路由已生效），纯装饰的无限循环一律不加——日志面板那颗心跳点就是因为一直在眼角闪而改成静止的。
9. **目前没有任何常驻装饰循环**：2026-10-01 的编辑器式改版把这批循环（背景漂移光晕、80s 轨道环、设备脉冲环、已生效连线的流动虚线）连同 `useDecorativeMotion()` 一起删掉了——静止是这个界面应有的样子，不要为了"有生气"把它们加回来。若将来确实需要新增常驻循环，必须自己按可见性与焦点把关（窗口不可见、失去焦点、或系统要求减少动效时冻结成静止一帧，而不是继续重绘）：一个后台窗口里每帧重算的滤镜与重绘，代价落在 WebView2 的 GPU 进程上，而任务管理器里那一条没人会算到这个程序头上。`reducedMotion="user"`（见上条）管的是入场与交互动画，与常驻循环不重叠。
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
- 延迟入口是**设备表格的 Delay 列**（`DeviceTable` 的延迟单元格里放 `DelayReadout`；列宽常量 `COL_DELAY` 由表头与行共用，两者不许各写一份）：
  签名数值 + 小号 `ms`，**没有任何 ± 按钮**，设备名只在同一行的名称单元格里写一次。
  这一列整体随 `advancedMode` 显隐（默认关，见「专家信息总闸门」）。
  横向拖动按配置步进连续调节（4px 一步），滚轮 / 方向键步进（Shift 十倍），点击键入精确值。
  拖动期间只更新本地预览、松手一次性提交（一次手势只留一条日志）；步进与键入即时提交。
  零值渲染为弱化色，非零或交互中才用 accent。
  **单元格宽度恒定**——悬停/编辑都不改变任何宽度（历史上那套「胶囊内嵌步进器 + 悬停展开」的方案已废弃，不要再复活）。
  不要在表格外面再做常驻面板。设置页仍保留逐设备列表（`DelayStepper`，−/数值/+），便于给未选中的设备预设延迟。
- 音量按设备持久化到 `app_data_dir/device-volumes.json`（`config.rs`，设备 -> %）。值与延迟同构：**以组内最响的一台为基准**，
  `duplication.rs` 的 `group_max_volume()` 取组内（含主设备）最大值，镜像按 `own / max` 在 `pump_render` 写设备**之前**缩放采样的增益；
  软件增益只能衰减，所以最响的那台无法被压低，只能作为基准，其余设备向它对齐。0 表示静音，100 表示原样（不落盘）。
  采样格式在 `start()` 时从 `WAVEFORMATEX`(可能 extensible) 解析成 `SampleFormat`（float32/float64/PCM 16·24·32），
  认不出的格式**跳过增益**而不是乱改数据；增益为 1.0 时直接短路，常规情况不付任何代价。
  **不要**再回到「按 exe 压会话音量」那套（`ISimpleAudioVolume` / `set_session_volume` / session-volumes.json 已于 2026-09-19 整体移除）。
  前端读数 `VolumeReadout` 是设备表格的 Volume 列（`COL_VOLUME`，同样只在 `advancedMode` 打开时存在），同为延迟右侧的独立单元格，套 `ScrubReadout`：
  0–100、固定步进 5%、3px 一步；tooltip 说明「相对同组最响的一台衰减」。进程列表里那个按程序的音量滑杆已随之删除。
- **每源电平是对我们捕获到的音频做的软件增益，不是那个应用的音量**（`source-volumes.json`，**exe -> %**，0–400，100 为原样）。它与设备份额**相乘**施加在同一处（`pump_render` 里的 `apply_gain`），键按**可执行文件名**——与路由归属同一条规则：一个程序可以有好几个会话，电平属于程序。
  - 这是本模块**唯一允许 >1.0** 的增益。设备份额只能衰减，因为设备头上还有硬件音量可拧；而一个程序的音频头上没有东西，比邻居轻就得放大它。`SOURCE_VOLUME_MAX`（约 +12 dB）是上限，再往上噪声底会一起抬起来。
  - ⚠️ **它不是复活 2026-09-19 删掉的那套**：那是 `ISimpleAudioVolume` 改应用自己的会话音量并落盘，会改变该应用在**所有**路径上的响度；这里是引擎对自己捕获到的字节做乘法，不碰应用、不写应用状态。UI 文案必须说清这一点，否则会被当成同一个东西。也正因如此它**只对正在路由的程序有意义**（没有引擎就没有这条路径），列表只列在路由的程序。
  - 电平表的键是 **(exe, pid)**，出口（`fresh_all`）再按程序折成一份、取**最响的那个窗口**：一个程序可以同时有好几个引擎（浏览器多窗口各路由一次），只按 exe 做键会留下「最后写入的那一个」，把对齐引到一个谁都不是的数字上。
  - **一键对齐**（`align_source_levels`）取「正在路由且在放音」的程序，把每条抬/压到「最响那条 × `ALIGN_HEADROOM`」。每条增益**双重设界**：`SOURCE_VOLUME_MAX` 的绝对上限，以及**该程序自己的实测峰值**（`1 / peak`）。
  - **这个上限的准确含义是「对它被测到的那段素材安全」，不是「永远不削顶」**：增益算一次就落盘并一直用，而峰值是在衰减的估计（`PEAK_RELEASE_MS`），所以一个被测得安静、之后才放响的程序仍可能被放大到削顶。文案与验收条目都必须按这个口径写，**不要**写成「不可能削顶」，否则下一个人会以为有硬保证。也正因为有这层保护，这里**不需要限幅器**。
  - 测得低于 `SILENT_LEVEL`（约 −60 dBFS）的程序**不参与对齐**：它的比值无界，会被夹到上限并**永久存成 400 %**，等着它第一次出声就放大。多源相加的削顶发生在 Windows 的混音里、这边看不见，headroom 只是礼让余量而非保证。
  - ⚠️ **`SOURCE_LEVEL_MAX`（TS）与 `SOURCE_VOLUME_MAX`（Rust）是两处字面量**，没有东西绑住它们——和版本号那三处一样容易漂移。改一处必须改另一处。
  - **没在放音的程序原样不动**并在结果里点名：对着静音做对齐等于对着「没有」做对齐。**读不出格式的程序也不能当成安静**（`measure_chunk` 返回 `None` 而不是 0），否则会被放大。
  - 电平表（`levels.rs`）**只回 1 秒内的读数**：进程回环只在程序真的出声时才给包，安静下来的程序会留着上一次的测量值，而过期读数会被当成「一个安静的程序」——那正是最该避免的误判。
  - **不要**为它加轮询或实时电平表：对齐是一次性动作，结果走日志与存下来的数值。
- 两个读数都靠 `EngineRole`（`mirror` / `primary` / `inactive`）说明**这个值此刻到底生不生效**，因为改得动不等于改了就有效：
  - `mirror` = 引擎在驱动这台设备，值直接生效；
  - `primary` = 系统直连播放，软件既加不了延迟也压不了音量，它的值只作为整组的基准，所以提示里要写明"只影响对齐参考 / 只作为响度基准"；
  - `inactive` = 没有任何引擎路径涉及它（未路由，或是单设备路由——单设备根本不启动引擎），此时读数**变淡**并提示原因。
  `lib/engineRole.ts` 的 `engineRolesFor` 从 `routedPids` 推导角色，**跳过长度 < 2 的路由**（单设备路由没有引擎），且 `mirror` 优先于 `primary`——一台设备同时是某条路由的镜像和另一条的基准时，它的值是在生效的。表格的行角色（`DeviceTable` 的 `roleOf`）与它分工不同：角色列还要表达 `staged`（已选未应用）与 `idle`，所以那一份的输入是 `activeDeviceIds()` 而不是引擎角色本身。
  提示的优先级是"最具体的原因先赢"：同步关闭 > 未生效 > 主设备基准。**不要**给单设备路由也照常显示一个看起来很有效的数值：用户会以为调了有用。
- **上报的延迟是软件侧的实测值**：`ActiveRoute.latency_ms`（与 `device_ids` 等长同序，主设备在前）给出每台设备**此刻实际在播**的软件侧延迟 = 该设备的管线深度（`target_frames`，含它自己的延迟补偿）+ 端点自报的 `GetStreamLatency`。前端存进 `deviceLatencyMs`（按设备 id），只有设备表格里延迟那一格用它，而且只作为 `DelayReadout` 的 tooltip 文案。
  - **主设备是 `null`，不是 0**：它由 Windows 直接播放，没有我们自己的流可问；`duplication.rs` 里 `stream_latency_ms == 0` 一律读作「未测量」（初始化即 0，查询失败也是 0），所以别把它当「零延迟」用。
  - **硬件的部分不猜**：编解码 / A2DP 缓冲在用户态不可观测，文案必须写明这是软件侧、实际听到的更晚，不能暗示它是全部声学延迟。
  - **role 与读数要交叉校验**：`deviceLatencyMs` 只在 `reconcileActiveDuplications` 里重建，而 `routedPids` 有多处会改，所以延迟单元格只在 `engineRole === 'mirror'` 时才把值当数——否则停掉路由后会留下一个描述"已经不存在的流"的数字。
  - **新起引擎的路径都要跟一次 `reconcileActiveDuplications()`**（手改路由、撤销、开机恢复记忆路由），否则那台设备要等到 Core Audio 下次变动才有读数。每次操作一次，**不要**改成轮询或定时器。
  - **声学那一半测不到，也不要假装测得到**：硬件编解码 / A2DP 缓冲在用户态不可观测，唯一的办法是用麦克风录下各设备实际发出的声音再做互相关——那会引入**录音权限**，属于新能力，**没有明确同意之前不要加**。也不存在「数字侧偏斜可自动测」这条路：每路镜像都读同一份捕获字节、管线深度由我们给定，镜像之间的数字差**就是配置的延迟本身**，是已知量而不是待测量。所以延迟补偿永远是「软件侧精确 + 声学侧靠耳朵」，**实测延迟读数**的 tooltip（`deviceLatency.reading`）与设置页的说明都要写明，别让用户以为那个数就是全部声学延迟。
- 复制引擎通过后端事件 `duplication-stopped`（pid / reason / error）向前端同步状态
- **单个镜像失败走自己的事件，不并进 `duplication-stopped`**：`duplication.rs` 的 `fail_mirror()` 发 `duplication-mirror-failed`（pid / generation / deviceId / error），引擎继续为其余设备播放。前端 `handleMirrorFailed` 用与引擎级事件**同一套 generation 守卫**（过期的镜像不得改动已经被替换掉的路由），再把该设备从 `routedPids[pid]` 里摘掉并写一条 error 日志点名它。
  修的是这个观感问题：以前只 `warn!` 到 release 会丢弃的 stderr，界面上整条路由看起来完整生效，但有一台设备根本没声音——和"程序坏了"没法区分。**不要把它并回 `duplication-stopped`**：那条会拆掉整个引擎，而这里其余设备还在正常出声。
- `stop_route` 返回 `StopOutcome`（`released` / `pinned_device`）：没释放成功时前端写一条 error 日志点名那台设备，而不是报"已恢复系统默认"；设置页的「重置每应用音频输出」、以及 `refreshSessions` 发现被路由的 pid 消失后调用的 `releaseStaleRoutes()`，都归到同一套端点归还逻辑（见下面「每应用端点分配的生命周期」）
- **撤销是一个快照，不是一叠栈**：`undoSnapshot` 记下这一路由**替换掉的**每一条（原设备列表），撤销时逐条放回：非空按 `orderByDelay` 重排后重路由（延迟最小的那台必须回到主设备位，否则用户设的延迟被静默不施加），原本没有路由的走 `stopRoute`。
  **记忆也要跟着处理**，否则下次启动会把刚撤掉的路由装回来：重路由那条用**与当初相同的 `remember` 标志**，于是旧设备列表被写回去；而 `stopRoute` 那条会**清掉**记忆——这里没有「写任意记忆」的命令，所以是清掉而不是还原，丢的是一条当时并未生效的记忆，比「撤销被悄悄翻回去」小得多。手动停止路由会**丢弃**快照（那条路由已被用户改过，再对它撤销就是逆着用户最后一次操作走）。
- **源数与设备数没有人为上限**：`apply_route(device_ids)` 与进程多选都不设上限，引擎按需起。本项目**不是**总线混音器，所以没有 Voicemeeter 那类「3/5/8 条 ins/outs」的硬限制——被问到「通道数能不能再多」时，答案是这个定位，而不是一个新功能。上报类结构（`ActiveRoute` 的 `device_ids` / `latency_ms`）一律是**平行数组、等长同序**，加条目时别破坏这一点。
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
- 通知触发的刷新是 `refreshDevices(true)` / `refreshSessions(true)`：**只有列表内容真的变了才写日志**（`devicesChanged` / `sessionsChanged`），手动的照旧固定写一行。注意 `refreshSessions` 的可选参数——点击处理器必须 `() => void refreshSessions()`，直接把函数交给 `onClick` 会把 MouseEvent 当成 `true` 传进去。通知处理（`syncFromNotification`）末尾还会跟一次 `reconcileActiveDuplications()`：引擎的报数（延迟读数、逐设备角色）没有自己的事件，靠这一次和下面两处才不至于永远停在旧值。
- **第四个引擎事件 `duplication-ready`**（pid / generation）：最后一个镜像初始化完成时由 `mirror_ready` 发一次，因为镜像的 `GetStreamLatency` 是在**渲染线程**里、在一次异步设备激活**之后**才拿到的，而 `apply_route` 早就返回了——前端若只在收到路由回执时读一次，读到的必然是空值，而且**再也不会重读**。`reconcileActiveDuplications()` 因此有四处调用：开机、路由落地后、撤销后、以及这个事件；外加改延迟之后与 `syncFromNotification`。**每一条新起引擎的路径都要跟一次**，否则那台设备的读数要么不出现、要么停在改动之前。
- 注册失败只 `warn!`，绝不致命：列表退化成手动刷新，窗口必须照常打开。

### 引擎的唤醒成本（2.2 起，改动前必读）

一条路由常驻就是一个引擎常驻，而引擎的成本**不在 CPU 百分比里**——它落在调度唤醒次数上。任务管理器把一个每 10 ms 醒一次的线程显示成几乎没有占用，风扇曲线却看得见，因为它一直进不了包 C-state。所以这个模块里每一处等待都要能说出自己是被什么唤醒的：

- **事件驱动的渲染客户端只被「喂」驱动**：客户端只要处于 `Start` 状态，就每个音频周期被信号一次，**与有没有东西可播无关**。所以「永远写满缓冲、静音也用 `AUDCLNT_BUFFERFLAGS_SILENT` 写」的写法会让设备流永不空闲，每路镜像稳定约 100 次/秒，长期不变。修法是**源静默后停放**：捕获侧为每个非静音包盖时间戳（`note_audio`），某路镜像缓冲排空且源静默超过 `SOURCE_IDLE_MS`（1.5 s）就 `Stop()` 掉它的客户端（`park_mirror`），下一个包直接唤醒该线程并 `Start()` 回来。停放只会丢掉静音：`SILENT` 包从不入环，且停放那一刻设备里存的也是静音，所以两个方向都听不见。**不要退回「一直写静音」**——那正是风扇投诉的来源。
- **唤醒必须显式，超时只能是兜底**：渲染线程用 `std::thread::park_timeout` 等，捕获侧用 `MirrorChannel::wake()`（`Thread::unpark`）唤醒；「先查条件、再停放」加上 token 语义保证了不会丢唤醒，`PARK_POLL` / `GATE_POLL` 的 250 ms 是「万一没醒」的上限而不是机制本身。**新增任何停放点都要在被唤醒那一侧接上 `wake()`**：`open_gate_when_ready`、`DuplicationManager::stop`、`capture_session` 退出前各有一处，缺一处就是让捕获线程陪着等完整个兜底超时。`Thread::unpark` 只对 `park_timeout` 有效，**对 `WaitForSingleObject` 无效**，两者不能混用。
- **唤醒计数是仪表**：`MirrorChannel.wakeups` / `EngineShared.capture_wakeups` 只在引擎退出时汇总成一行 `info!`，没有任何音频路径读它。改循环节奏时用它对照前后，比看任务管理器可靠。
- **空闲引擎唯一还在做的事就是存活性检查**，所以它不能每次都多开一对句柄：`process_alive` 复用已打开的句柄读创建时间（`creation_time_of`）。同理，不要为了「以后可能有用」在每个周期里加系统调用。
- **已知且接受的取舍**：镜像停放期间设备被拔掉不会立刻报 `duplication-mirror-failed`，而是推迟到音频恢复、真正要写设备的时候。原实现也不是靠超时发现设备消失的（超时分支只 `continue`），而是靠写失败，而停放时不写。设备列表本身仍由 `audio-changed` 实时更新。

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
- 色板为青色（cyan）信号色，不用靛紫/紫罗兰；改色时 `:root` / `.dark` 两份定义与 `--*-rgb` 镜像通道必须一起改（`--bg-primary` / `--text-primary` 还在 `index.html` 里各有一份首帧内联副本，也要同步）
- 角色四色（`--type-*`）只属于画布：**同一个颜色画三处**（端口 / 连线 / 角色词），所以它们没有 `-hover` 之类的变体，
  也不许拿去给别的东西上色。`--bg-primary` 在这一版是**画布那张板**的颜色，不是普通的窗口底色——
  见「节点画布 UI 规范」里对亮色下它必须比 `--surface-sunken` 更深的要求

```css
:root {
  --bg-primary: #e4eaf1;      /* 画布：凹进去的板，比侧栏更深、更冷几度 */
  --bg-tertiary: #e8e8ec;
  --text-primary: #18181b;
  --text-secondary: #3f3f46;
  --text-muted: #71717a;
  --accent: #0891b2;
  --accent-hover: #0e7490;
  --accent-muted: rgba(8, 145, 178, 0.12);
  --accent-ink: #ffffff;      /* 压在 accent 填充上的文字 */
  --success: #10b981;
  --error: #ef4444;
  /* 平面：chrome 是一个连续的框（标题栏 + 标签页 + 侧栏 + 画布头部），
     画布是框里凹下去的那张板；只有真正浮在内容之上的东西（确认胶囊、弹窗）用 raised。 */
  --surface: #ffffff;         /* 设置页那张纸 */
  --surface-sunken: #f2f3f5;  /* 框：导航与画布头部 */
  --surface-raised: #ffffff;  /* 真正浮起来的东西：确认胶囊、弹窗 */
  --surface-hover: rgba(24, 24, 27, 0.035);
  --hairline: #e6e6ea;        /* 行与行、块与块之间的分隔 */
  --hairline-strong: #d4d4da; /* 需要读成"边界"而非"分隔"的少数边缘 */
  /* 画布 */
  --canvas-grid: rgba(37, 63, 99, 0.075);       /* 24px 细格 */
  --canvas-grid-strong: rgba(37, 63, 99, 0.14); /* 120px 粗格 */
  --node: #ffffff;            /* 节点卡片的底色 */
  --node-border: #cfd9e6;     /* 节点描边：这是"边界"，不是 hairline */
  /* 角色四色 */
  --type-primary: #0891b2;
  --type-mirror: #0f766e;     /* 与 primary 同族、深两阶：复制是同一件事的另一半 */
  --type-staged: #d97706;     /* 琥珀＝尚未被回答的问题；刻意不用绿色 */
  --type-idle: #94a3b8;
}
.dark {
  --bg-primary: #05080c;      /* 画布 */
  --bg-tertiary: #27272a;
  --text-primary: #fafafa;
  --text-secondary: #d4d4d8;
  --text-muted: #a1a1aa;
  --accent: #22d3ee;
  --accent-hover: #06b6d4;
  --accent-muted: rgba(34, 211, 238, 0.14);
  --accent-ink: #05222b;
  --success: #34d399;
  --error: #f87171;
  --surface: #12151a;         /* 设置页那张纸 */
  --surface-sunken: #0e1114;  /* 框：导航与画布头部 */
  --surface-raised: #161c24;  /* 浮起来的东西 */
  --surface-hover: rgba(255, 255, 255, 0.035);
  --hairline: #23272e;
  --hairline-strong: #2e3742;
  --canvas-grid: rgba(125, 175, 225, 0.075);
  --canvas-grid-strong: rgba(125, 175, 225, 0.14);
  --node: #141a23;
  --node-border: #2a3441;
  --type-primary: #22d3ee;
  --type-mirror: #14b8a6;
  --type-staged: #fbbf24;
  --type-idle: #64748b;
}
```

---

## 节点画布 UI 规范（2026-10-02 改版，改动前必读）

路由页是一张**节点图**：左边一个源节点（当前程序），右边每台输出设备一个节点，节点之间的贝塞尔连线**就是**这条路由。
视觉语言借自虚幻引擎蓝图——节点按它承载的东西上色，端口与连线同色，于是整张图不需要图例。

这是第四次改版，前三次各有各的复活风险，逐条写明，别把删过的东西再拿回来：

| 版本 | 内容 | 现状 |
|------|------|------|
| ① 液态玻璃 + 同心圆舞台 + 胶囊节点 | `ConcentricRouter` / `DeviceAnnotation` / `OutputStatusBar` / `useFitScale` / `useDecorativeMotion` / `--glass-*` | 已删。**只有同心圆环以端口形态回来了**，见下 |
| ② 设备表格上面再画一棵路由树 | `RouteFlow` / `RouteSubject` | 已删，不要复活：同一批设备列两遍，两遍的排序依据还不同 |
| ③ 扁平编辑器式 + 设备表格 | `DeviceTable` | 本次被画布取代 |

⚠️ **同心圆在这一版只允许出现在端口上**（以及源节点那个三环扇出点）。不要再有舞台、轨道环、背景水印那类同心圆装饰。
①的失败不在于用了圆环，而在于用位置去说连接：设备围着中心排一圈，"谁连到谁"要靠推理。这个界面要说的是**方向**，方向要用线说。

### 为什么不是表格

表格说对了四件事（哪台设备、路由拿它做什么、延迟、音量），排序规则把剩下的也说了：在路由里的排到最前，末尾用一条更重的线收束。
它读起来是一份清单，**读不出"流向"**——而这张屏讲的正是流向：有东西正被送去别处。
四个列头花掉一整行去解释一个形状，而那个形状本来可以免费交给眼睛。

所以：源节点在左，设备节点在右，在路由里的每台设备一条曲线。
- 排序规则**原样保留**：在路由里的仍是靠前的那几台，从上到下的顺序就是路由顺序，也正是连线扇出的顺序。
- 列头**也保留**，对齐到节点自己的内部列。延迟与音量是相隔几个像素的两个数字，没有标签就是一道谜题。

### 节点几何（`lib/canvas.ts`）

`BOARD_PAD` / `HEAD_H` / `NODE_H` / `NODE_GAP` / `SOURCE_W` / `NAME_W` / `ROLE_W` / `DELAY_W` / `VOLUME_W` / `COLUMN_GAP`
是**唯一的**尺寸来源：组件用 `style` 从这些常量取宽高，**不要**改成 Tailwind 的 `w-[…]` 类，更不要在组件里另写一份。
两条线之间的曲线是从这些数字**算出来**的，不是拿 `getBoundingClientRect` 量出来的——所以节点和接到它上面的线不可能对不上。

同一条理由也决定了这里**没有自由拖动、没有平移、没有缩放**：
- 节点位置由路由顺序决定 → 几何是算术 → 不需要 ResizeObserver，也不需要每次 layout 重算端点；
- 一块放得下的画布没有可探索的东西。平移和缩放是用来找你看不见的东西的，而这里全都看得见。

要加拖动，就得先把几何换成测量，然后每次布局都重算端点，还要在动画期间给节点钉住"被测到的那一帧"。
换来的是五六台设备的桌面音频输出能摆成自定义布局。不值得。

### 节点

- **源节点**（`SourceNode`）：当前选中的程序，名字 + `PID`。**没有悬停态，也不可点**——它不是一个决定，应用列表已经替它决定了；
  一张会高亮却点不动的卡片，是在承诺一件指针做不到的事。它的说明在 tooltip 里（`canvas.sourceHint`），
  第一次看的人在那里知道右边的线是这台程序的声音。
  它的输出端口是**唯一**画到三环的地方（`border-accent/40` 外环 + `border-accent` 中环 + accent 芯）：它是扇出点，每条线都从这里出发。
- **设备节点**（`DeviceNode`）：一张 `rounded-[10px]` 的卡片，`bg-node` + 一圈描边，从左到右是
  名称按钮（`NAME_W`）/ 角色词（`ROLE_W`）/（`advancedMode`）延迟（`DELAY_W`）/ 音量（`VOLUME_W`）。
  - ⚠️ **`rounded-[10px]` 是这一版唯一允许的大圆角**，且只给节点。圆角的意义是"这是一个对象"，而整张屏上只有节点是对象；
    其余平面仍然不圆角，按钮与标签仍然是 `rounded`（约 4px）。
  - **端口是同心圆**：外环描边 + 内芯实心，**中间那圈什么都不画**，透出节点自己的底色——
    有那圈间隙才读得出是同心的，否则是"一个点加一块糊掉的东西"。所以外环是透明盒子上的 `border`，不是一个垫在下面的实心圆。
  - **两侧都有端口**：左边接进路由，右边是没有插线的另一侧（`dormant`）。蓝图节点两边都有引脚，
    只画用上的那一侧，会让画布的两边对"节点是什么"给出两种答案。
  - **悬停放大只放卡片，不放端口**：端口是卡片的**兄弟**而非子元素，所以线在卡片动的时候仍然接在端口上。
  - 悬停辉光是一层单独的 `<span>` 用 opacity 淡入，不是在卡片上动 `box-shadow`：
    同色的阴影得在运行时从主题通道拼出来，而 opacity 是唯一一个动起来不花钱的属性。
  - **名称的第二行（`System default`）无论有没有内容都占位**：只有默认设备那台有字。
    不占位的话它会把自己的名字顶上去半行，一列名字就没有共同基线了。
  - 角色词挂 tooltip（`canvas.role*Hint`）解释这个词是什么意思：颜色负责编码，文字负责照顾还没见过它的人。
- **角色四色**（`TONE`，`lib/canvas.ts`）：`primary`（系统直接播放）/ `mirror`（复制引擎驱动的副本）/ `staged`（选了还没确认）/ `idle`（没参与任何路由）。
  **同一个颜色画三处**：端口、进这个节点的连线、角色词。
  - `primary` = accent：accent 本来就是"属于路由的那部分"的记号。
  - `mirror` = accent 的**邻近色相**（teal），不是第二个 accent：它和 primary 是同一件事的两半，两个不相干的颜色会说它们不相干。
  - `staged` = 琥珀色，**尚未被回答的问题**的颜色。刻意不用绿色：什么都还没发生。
  - `idle` = slate，而且**不上底纹、不发辉光**。大多数设备在大多数时候都是空的，一张到处都染色的画布等于没染色；
    只有指针停在上面时才给它一层很淡的辉光。
- **列头行**：`Device / Role /（高级）Delay / Volume`，对齐到节点的内部列。列头**没有**下边框——下面那片网格自身就是边界。

### 连线（`EdgeLayer`）

- 一张 `<svg>` 画完所有曲线，垫在节点下面。不按节点各画各的，是因为一条线不属于它两端任何一个节点。
- 每条线画两遍：底下一层更宽更淡的，上面一层细的。**这就是全部的辉光**——没有 filter，没有 blur。
- 三次贝塞尔，两个控制点都是水平的，所以线平着离开端口、平着进入端口：斜着接上端口的线看起来像接歪了。
- ⚠️ **连线不动**。"流动虚线"是让路由看起来活着最顺手的办法，也是让整个会话每一帧都在重绘的办法。
  线已经按它承载的东西上了色，它到达的端口也已经是同色的一圈——路由静止着就看得懂，那就让它静止。
  验收清单里「界面静止时不产生任何常驻重绘」是这一条的硬约束。

- **布局**：`TitleBar`（36px，`bg-surface-sunken` + 下边框）→ 一行两栏：左 `aside` 264px 应用列表（`bg-surface-sunken` + `border-r border-line`）
  ＋ `main` 工作区。**chrome 是一个连续的框，画布是框里凹下去的那张板**：标题栏、标签页、画布头部同在 `bg-surface-sunken` 面，
  画布自己铺 `bg-bg-primary` + `.board-grid`（24px 细格 + 120px 粗格，两条都是 1px 渐变，静态）。
  ⚠️ 亮色下 `--bg-primary`（#e4eaf1）必须比 `--surface-sunken`（#f2f3f5）**更深**，侧栏才读得出是框、画布才像凹进去的板；
  只差几个色阶时两者看起来是同一块，侧栏就不像侧栏，像页面上一块忘了上色的地方。
  ⚠️ `--bg-primary` / `--text-primary` 在 `index.html` 里还有一份首帧内联副本，改色必须两边同步。
  设置页覆盖整个工作区，自己是一列设置（`max-w-2xl` 居中）。
- **标签页**：`UnderlineTabs`（`role="tablist"`/`tab`），「Routing / Activity」。活动记录是**标签页**而不是折叠条：
  折叠条会被每次从设置页返回时重新展开，而专家信息本该是 opt-in 的。
- **画布头部**（`RouteCanvas` 顶部，h-10）：左边是「这是谁的输出」——选中的程序 + `PID`，没有选中时是 `router.guide` 那句引导；
  右边是多选计数与 `ConfirmButton` 的「回到系统默认」。它**不带下边框**：下面网格的边缘比一条 hairline 响。
  ⚠️ **顶部不要再放第二条状态条**（`OutputStatusBar` 就是这样被删掉的）：同一件事说两遍会像两套状态。
- **路由只由画布表达**：源节点与设备节点之间的连线就是这条路由（`routeIds` = `selectedDeviceIds`，为空时退回 `activeIds`）。
  节点顺序按路由顺序**稳定排序**，在路由里的排在最前——这一点和表格时代一致，只是"靠前的那几台就是这条路由"现在由线来说。
  ⚠️ **不要再在别处画第二份路由**（一棵树、一条状态条、一段文字摘要）：同一件事说两遍，两遍的排序依据还很容易不同，
  读起来是 bug 而不是两个视图。
- **可点的只有设备节点的名称按钮**（`aria-pressed`）：延迟与音量是它**旁边**的独立控件，控件不能嵌在控件里（键盘够不到）。
  节点容器挂 `data-device-row`，e2e 读整个节点（角色词在按钮**外面**，用名称按钮定位读不到它）。
- 角色词：`primary` / `mirror` / `staged`（已选未应用）/ `idle` → `—`（不标注，因为大多数设备大多数时候都是空的）。
- **专家信息总闸门（`advancedMode`，`aar-advanced-mode`，默认关）**：它现在只管一件事——设备节点上的延迟与音量两列。
  活动记录**不再**受它控制：日志是标签页，本身就是 opt-in 的。开关的副标题文案必须跟这个事实一致（别写成"显示完整日志"，那是改版前的事）。
- **悬浮确认胶囊**（`RouteConfirmCapsule`）：底部一个满宽 `pointer-events-none` 的绝对定位层 + `justify-center`，只有胶囊本身可点，所以它浮着**不占布局、不推动任何东西**。
  内容：`源 → 目标 (+n)` ＋ 一条竖 hairline ＋ 两个并列按钮（取消 / 路由）。**不用**「按一下变成另一种按钮」的做法：两个答案并排，问题才看得见。
  - `alreadyApplied()`：staged 跟正在播放的一模一样时不问——刚路由完、或重新选中一个已路由的程序，都属于"你在看着答案，不该再问你一遍"。
  - 取消 = 逐项 `toggleDeviceSelection`，每次都读**实时** state（不是渲染时的快照，否则前一次调用就把它作废了）。
  - ⚠️ **Escape 监听是捕获阶段的，且只在胶囊真的在屏时才注册**（`question !== null`）：捕获阶段是为了抢在背后那个控件之前吃掉这个键，
    也正因如此，**常驻注册会把整个窗口的 Escape 都吞掉**——搜索框按 Esc 清空、设置页按 Esc 返回全部失效。
    这个 bug 真的出现过（2026-10-01 由 e2e 抓出），把它当规矩记住：**捕获阶段的全局监听必须跟着可见性注册与注销**。
- **左栏选中态**：2px 左侧条（`SelectionMark`，`bg-accent`），不是跨行滑动的共享胶囊；行与行之间是 hairline，不是圆角卡片。
- **左栏（`ProcessList`）**：已路由进程行末只有一个 accent 圆点（"它的声音去了别处"），**不写设备数**——数写在上面那行的设备名后面（`+n`），同一件事写两遍就是两个数。
  停止路由的 ✕ 只在**行悬停 / 焦点进入**时出现（`group/row` + `opacity-0 group-hover/row:opacity-100`）：每行都挂个叉，列表就读成一份待删除清单。
  每行第二行是 `PID xxx`，**只有已路由的行**才追加 `· 当前播放设备`——没路由的程序全都走同一个系统默认设备，
  逐行重复它是一列一模一样的文字，还会让每个程序看起来都被送往了某处（同一行内，不要再单开一行显示设备）。
  - 列表顶部有搜索框：`query` 是**组件本地 `useState`**，不进 store（它是视图状态，不是应用状态）；按 `exe_name` 过滤（`display_name` 已被后端移除，别再引用），`Escape` 清空并失焦。
  - 已路由的进程**排到最前**：按 `routedPids` 长度做**稳定**排序，让组内保持枚举顺序——否则行会在每次刷新时互相换位，鼠标底下的目标就跑了。
  - 无匹配时显示 `processList.noMatch`，**不要**复用 `processList.empty`：「没有进程在放音」和「你的搜索词没匹配上」是两件事，后者提示"让程序发声"是答非所问。
- **撤销优先于确认**：路由不加确认（点一下就路由是这个应用的手感），撤销是那个瞬态 Toast（`role="status"`，唯一的撤销入口）。
  `ConfirmButton`（先「确认？」再执行，Escape / 失焦 / 5 秒超时解除）只留给**破坏性且影响全局**的动作：左栏表头的「全部回到系统默认」、
  画布头部的「回到系统默认」（作用域 = 选中的已路由程序；没有选中时 = 全部已路由程序，因为那是唯一能走出"看不见的路由"的出口）。
- **accent 只用来标记"属于路由的那部分"**：① 左栏选中（2px 色条 + 极淡底纹）；② 被移离中性位的值（延迟非 0、音量非 100）；
  ③ 源节点的端口，以及 `primary` 那一色的节点与连线；④ 胶囊里那个动作词。除此之外一律 muted——
  读数、说明、版本号都是。角色词按角色上色（那是编码本身），只有 `idle` 的 `—` 是 muted。
  实测延迟是**读数不是控件**，所以它连 accent 都不穿（否则用户会伸手去拖它），而且它只活在 tooltip 里（`deviceLatency.reading`）：
  两个数字并排几个像素，会被读成一个坏掉的数。
  数字与标识符（PID、毫秒、百分比、版本号、exe 名）用 `font-mono` + `tabular-nums`：等宽是这类界面里"这是数据"的记号。
- **禁止**：胶囊/药丸状按钮与标签页、玻璃与 `backdrop-blur`、`rounded-2xl` 及更大的圆角、boxy card（有底纹有描边有阴影，
  却什么都不说的那种块）、常驻装饰循环（背景漂移光晕、轨道环、脉冲环、**流动虚线**）、画布的拖动·平移·缩放、节点位置的手工保存。
  圆角只用在两处：控件（`rounded`，约 4px）与节点卡片（`rounded-[10px]`）。平面本身不圆角。
- **动效**：下划线迁移、胶囊浮出、节点重排都用 `SPRING_GLIDE`，纯透明度用 `FADE`，微交互（悬停放大）用 `SPRING_TAP`
  （全部取自 `lib/motion.ts`，不在调用点现调参数）。路由的扇出本身就是动画预算：一台设备加入路由时，它的节点走一段弹簧、线跟着到。

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
- [ ] 功耗：路由一个程序到 2–3 台设备后让它静默，`powercfg /energy` 里本进程的唤醒数从约 100×设备数/秒降到个位数；音频恢复时无爆音，停顿后第一声的延迟与连续播放一致
- [ ] 延迟/音量的生效提示：单设备路由时读数变淡并说明不生效；主设备的提示写明它只作基准
- [ ] 实测延迟读数：路由一个程序到 2–3 台设备，镜像设备显示软件侧延迟且**随延迟补偿变化**；主设备显示「无法测量」而不是数字；单设备路由与未路由各显示对应说明；停掉路由后读数**立刻消失**，不留旧数字
- [ ] 每源电平：路由两个程序到同一组设备，把其中一个调到 <100 或 >100，只有它的响度变；100 时该 exe 不落盘（`source-volumes.json` 里查不到）
- [ ] 一键对齐：两个程序同时放音，点「对齐电平」后两条响度接近，且**没在放音的程序原样不动并在日志里被点名**；只有一个程序在放音时提示说的是「只有一个」而不是「没有在放音」
- [ ] 撤销：改路由后撤销回到上一步；撤销一个原本未路由的进程 = 回到未路由；开了自动记忆时，**撤销之后重启该程序不会把撤掉的路由装回来**；手动停掉某条路由后 Toast 不再提供撤销
- [ ] 误操作防护：列表头的「全部回到系统默认」与设备表表头的同一个动作都需二次确认（Escape / 失焦 / 超时解除）；Toast 退场时不吃掉紧接着的点击
- [ ] 确认胶囊只在有内容可确认时出现；`Escape` 关掉它，且**搜索框里的 `Escape` 仍然能清空搜索**（胶囊不在屏时不许吃掉这个键）
- [ ] Light/Dark 切换流畅
- [ ] 切页与下划线迁移流畅（60fps），界面静止时不产生任何常驻重绘
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
