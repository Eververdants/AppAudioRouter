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
│       │   ├── sessions.rs     # IAudioSessionEnumerator 会话枚举 + 显示名装配（窗口标题 → FileDescription）
│       │   ├── process_meta.rs # 音频之外的进程元数据：盘符形式镜像路径、窗口标题（一次 EnumWindows 扫全表）、FileDescription、图标提取（按路径缓存，含 miss）
│       │   ├── routing.rs      # 每应用端点：槽 25/26 写入·释放·读回（null HSTRING = 清除）+ 系统关键进程拦截 + PinnedRoutes（本进程写过的分配，停止/退出/重置时归还）
│       │   ├── duplication.rs  # WASAPI 进程回环 → 多设备复制引擎（源静默后停放；见「引擎的唤醒成本」）+ 每源电平估计与增益
│       │   ├── levels.rs       # 每源电平表：各引擎写自己的估算，对齐与诊断都从这里读（只回 1 秒内的读数）
│       │   └── notifications.rs # 变更通知线程 → audio-changed 事件（设备/会话实时刷新）
│       └── config.rs       # 配置持久化（route-memory.json: exe -> 设备列表；device-delays.json: 设备 -> 延迟补偿 ms + delay_range_ms 正负范围上限；device-volumes.json: 设备 -> 音量 %；source-volumes.json: exe -> 电平 %（可 >100）；app-settings.json: close_to_tray）
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── ConcentricStage.tsx   # 同心圆舞台，也是路由唯一被表达的地方：中心是被选中的那个程序（Hub），每台输出设备一枚环绕它的玻璃圆盘（Satellite），每枚参与路由的圆盘与中心之间一根辐条；内含只给副本用的 Tuner
│   │   ├── ProgramRail.tsx       # 左栏程序列表：每行一个正在出声的程序，行末那颗圆形开关「也一起改」取代了 Ctrl+点击
│   │   ├── ActionDock.tsx        # 工作区底部悬浮玻璃条：一句话 + Apply（舞台永远只是提案）；唯一的「回到系统默认」也在这里
│   │   ├── SourceLevelDial.tsx   # 中心圆盘下方的每程序电平环（0–400 %，套 ScrubReadout 的 lead 槽画环），只在多设备路由时挂载
│   │   ├── Toast.tsx             # 瞬态提示：路由后提供「撤销」（全项目唯一的撤销入口）
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/已记忆路由列表/每应用音频重置/后台开关/延迟范围·步进/一键对齐/关于）
│   │   ├── LogPanel.tsx          # 活动记录（下划线标签页的第二页）
│   │   ├── TitleBar.tsx    # 自定义标题栏（透明，极光从它底下过：品牌 + 「已路由 · 在响」计数 + 设置入口 + 窗口控制）
│   │   ├── StartupNoticeDialog.tsx  # 启动提示弹窗（欢迎语 / 旧版本提示 + 就地重置）
│   │   └── ui/             # 基础控件
│   │       ├── Ring.tsx                # 同心圆指示器：外环说"它是什么"，内芯说"它在不正在响"；全项目共用这一枚
│   │       ├── ProcessIcon.tsx         # 每程序的 exe 图标槽（数据在 store 的 iconByExe）：像素未到或没有时显示显示名首字母，槽位尺寸固定不移位
│   │       ├── Switch.tsx              # 开关（h-5 w-9）
│   │       ├── UnderlineTabs.tsx       # 下划线标签页（不是胶囊；下划线用 layoutId 迁移）
│   │       ├── SegmentedControl.tsx    # 下划线式分段控件（不是胶囊，也不是 pill track）
│   │       ├── ScrubReadout.tsx        # 通用「数值即控件」（拖动/滚轮/方向键/键入），电平环在用；lead 槽可在数字前挂一个跟随预览值的图形
│   │       ├── StepButton.tsx          # 方形 ± 按钮（h-6 w-6，仅设置页在用）
│   │       ├── ConfirmButton.tsx       # 二次确认按钮（先「确认？」再执行；Escape/失焦/超时解除）
│   │       └── DelayStepper.tsx        # 设置页的延迟行控件（−/数值/+ 方框样式）
│   ├── hooks/              # 自定义 hooks
│   │   ├── useTheme.ts
│   │   ├── useLanguage.ts
│   │   ├── useDelayValue.ts  # 延迟编辑状态（草稿/提交/步进），两个延迟控件共用
│   │   ├── useLiveness.ts    # 声流闸门：窗口可见 + 持有焦点 + 未要求减少动效；三者任一不满足返回 false
│   │   ├── useGlassSpecular.ts # 玻璃高光跟指针：一个委托 pointermove 写 --gx/--gy 到悬停的面板
│   │   └── useBackendEvent.ts # 后端事件订阅（StrictMode 安全的 token 交接），四个事件共用
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
│   │   ├── stage.ts        # 舞台几何：中心/圆盘/辐条的尺寸与角度（辐条两端由此算出，不测量）+ 三种角色各自的配色类名
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
   - 组件：`PascalCase` (`ProgramRail.tsx`)
   - Hooks：`use` 前缀 (`useTheme.ts`)
   - 工具函数：`camelCase`
   - 常量：`SCREAMING_SNAKE_CASE`
   - 类型/接口：`PascalCase`，**不**加 `I` 前缀
6. **Tailwind**：优先 utility class，禁止自定义 CSS 类（除非通过 `@apply` 或 CSS variables）
7. **动画**：统一使用 Motion 组件，禁止手写 `@keyframes`（除非 Motion 无法实现）。spring 与时长一律取 `lib/motion.ts` 的四条共享曲线——`SPRING_TAP`（微交互）/ `SPRING_GLIDE`（有位移的元素）/ `SPRING_ROUTE`（路由动作本身）/ `FADE`（纯透明度），**不要在调用点现调参数**：邻居之间弹得不一样看着像 bug，不像设计。`main.tsx` 的 `MotionConfig reducedMotion="user"` 已全局跟随系统「减少动态效果」，新增动画不必各自判断。
8. **动效只用来报告状态**：动画要说明一件正在发生的事（视图切换、下划线迁移、操作条浮出、路由已生效、程序正在出声），纯装饰的无限循环一律不加——日志面板那颗心跳点就是因为一直在眼角闪而改成静止的。
9. **常驻循环只有两个，且都必须被闸门看住**：一是**辐条上的流动虚线**（报告"这个程序此刻正在出声"），二是**同心圆环的脉冲**（报告同一件事）。
   2026-10-01 删掉了那批装饰循环（背景漂移光晕、80s 轨道环、设备脉冲环），连同 `useDecorativeMotion()`；2026-10-03 的同心圆舞台把这两个*有信息*的循环请了回来——
   除此之外仍然一个循环都不许有。闸门（`useLiveness`）是硬约束：窗口不可见、失去焦点、或系统要求减少动效时，这两层都**卸载**（辐条回到静止实线、脉冲环不再存在），不是暂停——静止的界面不产生任何重绘。
   若将来要再加常驻循环，必须同样按可见性与焦点把关：一个后台窗口里每帧重算的滤镜与重绘，代价落在 WebView2 的 GPU 进程上，而任务管理器里那一条没人会算到这个程序头上。
   ⚠️ **新加一处脉冲或流动时，别忘了把它也接到 `useLiveness`**——它是 hook 而不是 CSS，不经由那道闸就等于没有。`reducedMotion="user"`（见上条）管的是入场与交互动画，与常驻循环不重叠。
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
- 延迟入口是**舞台上副本那一行 `−/数值/+`**（`ConcentricStage` 的 `Tuner`）：签名数值 + 小号 `ms`，
  每按一次走 `delayStepMs`，到 `±delayRangeMs` 的两端时对应方向禁用。**没有拖动、没有滚轮**——这两个数改的是此刻听到的东西。
  设置页另有逐设备列表（`DelayStepper`），用来给**当前没并进这条路由**的设备预设延迟；两处不是一个东西：
  舞台改的是"这条路由里的这一份副本"，设置页改的是"这台设备"。
  ⚠️ 历史上那一套「设备表格的 Delay 列（`COL_DELAY` 宽度常量）+ 横向拖动 + 滚轮 + 键入 + `advancedMode` 显隐」已删，
  **不要复活**：同一个数在两个地方能改，一定有先后之争，而这里没有正确答案。
- 音量按设备持久化到 `app_data_dir/device-volumes.json`（`config.rs`，设备 -> %）。值与延迟同构：**以组内最响的一台为基准**，
  `duplication.rs` 的 `group_max_volume()` 取组内（含主设备）最大值，镜像按 `own / max` 在 `pump_render` 写设备**之前**缩放采样的增益；
  软件增益只能衰减，所以最响的那台无法被压低，只能作为基准，其余设备向它对齐。0 表示静音，100 表示原样（不落盘）。
  采样格式在 `start()` 时从 `WAVEFORMATEX`(可能 extensible) 解析成 `SampleFormat`（float32/float64/PCM 16·24·32），
  认不出的格式**跳过增益**而不是乱改数据；增益为 1.0 时直接短路，常规情况不付任何代价。
  **不要**再回到「按 exe 压会话音量」那套（`ISimpleAudioVolume` / `set_session_volume` / session-volumes.json 已于 2026-09-19 整体移除）。
  前端入口同样是舞台上副本那一行控件：0–100、固定步进 5%（按钮），`title` 里说明「相对同组最响的一台衰减」。
  历史上有过的那些（`VolumeReadout`、设备表格的 Volume 列与 `COL_VOLUME`、按程序的音量滑杆、`advancedMode` 总闸）都已删除，别复活。
- **每源电平是对我们捕获到的音频做的软件增益，不是那个应用的音量**（`source-volumes.json`，**exe -> %**，0–400，100 为原样）。它与设备份额**相乘**施加在同一处（`pump_render` 里的 `apply_gain`），键按**可执行文件名**——与路由归属同一条规则：一个程序可以有好几个会话，电平属于程序。
  - 这是本模块**唯一允许 >1.0** 的增益。设备份额只能衰减，因为设备头上还有硬件音量可拧；而一个程序的音频头上没有东西，比邻居轻就得放大它。`SOURCE_VOLUME_MAX`（约 +12 dB）是上限，再往上噪声底会一起抬起来。
  - ⚠️ **它不是复活 2026-09-19 删掉的那套**：那是 `ISimpleAudioVolume` 改应用自己的会话音量并落盘，会改变该应用在**所有**路径上的响度；这里是引擎对自己捕获到的字节做乘法，不碰应用、不写应用状态。UI 文案必须说清这一点，否则会被当成同一个东西。也正因如此它**只对正在路由的程序有意义**（没有引擎就没有这条路径），电平环挂在舞台中心底下、只在 ≥2 台设备时才出现（2026-10-03 起设置页的逐程序列表已删——同一件事不画两遍；设置页只留一键对齐）。
  - 电平表的键是 **(exe, pid)**，出口（`fresh_all`）再按程序折成一份、取**最响的那个窗口**：一个程序可以同时有好几个引擎（浏览器多窗口各路由一次），只按 exe 做键会留下「最后写入的那一个」，把对齐引到一个谁都不是的数字上。
  - **一键对齐**（`align_source_levels`）取「正在路由且在放音」的程序，把每条抬/压到「最响那条 × `ALIGN_HEADROOM`」。每条增益**双重设界**：`SOURCE_VOLUME_MAX` 的绝对上限，以及**该程序自己的实测峰值**（`1 / peak`）。
  - **这个上限的准确含义是「对它被测到的那段素材安全」，不是「永远不削顶」**：增益算一次就落盘并一直用，而峰值是在衰减的估计（`PEAK_RELEASE_MS`），所以一个被测得安静、之后才放响的程序仍可能被放大到削顶。文案与验收条目都必须按这个口径写，**不要**写成「不可能削顶」，否则下一个人会以为有硬保证。也正因为有这层保护，这里**不需要限幅器**。
  - 测得低于 `SILENT_LEVEL`（约 −60 dBFS）的程序**不参与对齐**：它的比值无界，会被夹到上限并**永久存成 400 %**，等着它第一次出声就放大。多源相加的削顶发生在 Windows 的混音里、这边看不见，headroom 只是礼让余量而非保证。
  - ⚠️ **`SOURCE_LEVEL_MAX`（TS）与 `SOURCE_VOLUME_MAX`（Rust）是两处字面量**，没有东西绑住它们——和版本号那三处一样容易漂移。改一处必须改另一处。
  - **没在放音的程序原样不动**并在结果里点名：对着静音做对齐等于对着「没有」做对齐。**读不出格式的程序也不能当成安静**（`measure_chunk` 返回 `None` 而不是 0），否则会被放大。
  - 电平表（`levels.rs`）**只回 1 秒内的读数**：进程回环只在程序真的出声时才给包，安静下来的程序会留着上一次的测量值，而过期读数会被当成「一个安静的程序」——那正是最该避免的误判。
  - **不要**为它加轮询或实时电平表：对齐是一次性动作，结果走日志与存下来的数值。
- **这两个参数在一台设备上到底有没有可能生效，现在是结构说了算，不再靠"一个角色枚举 + 一句变淡的提示"**。
  舞台只给副本（`role === 'mirror'`，且路由长度 > 1，也就是确实有引擎在跑）画延迟与音量（`ConcentricStage` 的 `Tuner`）；
  主设备与空闲设备**根本不画控件**。理由是硬的：路由里的第一台由 Windows 自己播放，那条路上没有属于我们的流——
  没有东西可以被压后，也没有东西可以被衰减。
  - 于是旧的说法（"`inactive` 时读数变淡并提示原因"）**作废**：变淡的控件会被读成"以后会生效"，而这里永远不会。
    角色只剩 `primary` / `mirror` / `idle` 三个，`lib/engineRole.ts` 与它的 `EngineRole` 枚举已全部删掉，别再搬回来。
  - 主设备的两个值依然有意义：**它们仍然要读、仍然要落盘**，只是不作为控件——延迟是整组的基准
    （每台设备补多少是它相对组内最小值的差），音量也是整组的基准（增益只能取 `own/max`，永远只能衰减）。
    单设备路由不启动引擎，所以那种路由既没有控件也不需要控件：同一条规则，两种表现，不要为它特例盖章。
- **上报的延迟是软件侧的实测值**：`ActiveRoute.latency_ms`（与 `device_ids` 等长同序，主设备在前）给出每台设备**此刻实际在播**的软件侧延迟 = 该设备的管线深度（`target_frames`，含它自己的延迟补偿）+ 端点自报的 `GetStreamLatency`。前端存进 `deviceLatencyMs`（按设备 id），只用在舞台上副本那一组延迟控件的 `title` 里（`ConcentricStage` 的 `Tuner`）——主设备与空闲设备没有那组控件，所以那个数也就不存在。
  - **主设备是 `null`，不是 0**：它由 Windows 直接播放，没有我们自己的流可问；`duplication.rs` 里 `stream_latency_ms == 0` 一律读作「未测量」（初始化即 0，查询失败也是 0），所以别把它当「零延迟」用。
  - **硬件的部分不猜**：编解码 / A2DP 缓冲在用户态不可观测，文案必须写明这是软件侧、实际听到的更晚，不能暗示它是全部声学延迟。
  - **role 与读数要交叉校验**：`deviceLatencyMs` 只在 `reconcileActiveDuplications` 里重建，而 `routedPids` 有多处会改，所以延迟读数只在角色是 `mirror` 时才被当成数——现在由舞台只给 `mirror` 挂控件来实现，别退回"照常显示再做校验"：停掉路由后会留下一个描述"已经不存在的流"的数字。
  - **新起引擎的路径都要跟一次 `reconcileActiveDuplications()`**（手改路由、撤销、开机恢复记忆路由），否则那台设备要等到 Core Audio 下次变动才有读数。每次操作一次，**不要**改成轮询或定时器。
  - **声学那一半测不到，也不要假装测得到**：硬件编解码 / A2DP 缓冲在用户态不可观测，唯一的办法是用麦克风录下各设备实际发出的声音再做互相关——那会引入**录音权限**，属于新能力，**没有明确同意之前不要加**。也不存在「数字侧偏斜可自动测」这条路：每路镜像都读同一份捕获字节、管线深度由我们给定，镜像之间的数字差**就是配置的延迟本身**，是已知量而不是待测量。所以延迟补偿永远是「软件侧精确 + 声学侧靠耳朵」，**实测延迟读数**的 tooltip（`deviceLatency.reading`）与设置页的说明都要写明，别让用户以为那个数就是全部声学延迟。
- 复制引擎通过后端事件 `duplication-stopped`（pid / reason / error）向前端同步状态
- **单个镜像失败走自己的事件，不并进 `duplication-stopped`**：`duplication.rs` 的 `fail_mirror()` 发 `duplication-mirror-failed`（pid / generation / deviceId / error），引擎继续为其余设备播放。前端 `handleMirrorFailed` 用与引擎级事件**同一套 generation 守卫**（过期的镜像不得改动已经被替换掉的路由），再把该设备从 `routedPids[pid]` 里摘掉并写一条 error 日志点名它。
  修的是这个观感问题：以前只 `warn!` 到 release 会丢弃的 stderr，界面上整条路由看起来完整生效，但有一台设备根本没声音——和"程序坏了"没法区分。**不要把它并回 `duplication-stopped`**：那条会拆掉整个引擎，而这里其余设备还在正常出声。
- `stop_route` 返回 `StopOutcome`（`released` / `pinned_device`）：没释放成功时前端写一条 error 日志点名那台设备，而不是报"已恢复系统默认"；设置页的「重置每应用音频输出」、以及 `refreshSessions` 发现被路由的 pid 消失后调用的 `releaseStaleRoutes()`，都归到同一套端点归还逻辑（见下面「每应用端点分配的生命周期」）
- **撤销是一个快照，不是一叠栈**：`undoSnapshot` 记下这一路由**替换掉的**每一条（原设备列表），撤销时逐条放回：非空按 `orderByDelay` 重排后重路由（延迟最小的那台必须回到主设备位，否则用户设的延迟被静默不施加），原本没有路由的走 `stopRoute`。
  **记忆也要跟着处理**，否则下次启动会把刚撤掉的路由装回来：重路由那条用**与当初相同的 `remember` 标志**，于是旧设备列表被写回去；而 `stopRoute` 那条会**清掉**记忆——这里没有「写任意记忆」的命令，所以是清掉而不是还原，丢的是一条当时并未生效的记忆，比「撤销被悄悄翻回去」小得多。手动停止路由会**丢弃**快照（那条路由已被用户改过，再对它撤销就是逆着用户最后一次操作走）。
- **显示名是显示层，exe 是身份层，两层不许互换**（2026-10-04 起）：`AudioSession.display_name`（`process_meta.rs`）按「窗口标题 → FileDescription → 无（前端显示 `exe_name`）」取链。窗口标题用**一次 `EnumWindows` 扫全表**拿，且**只有可见窗口有资格**（Z 序、无 owner、非 tool window 者优先；隐藏窗口的标题是别人的管件——steam.exe 有个不可见窗口标题就叫「无标题」，而可见的 Steam 窗口属于 steamwebhelper.exe——托盘常驻的程序理应落到 FileDescription）。FileDescription 读一次后按镜像路径在本轮枚举内缓存——浏览器十几个进程共享一个文件。
  - ⚠️ **`VerQueryValueW` 的长度单位有两套**：字符串值是**含 null 的字符数**，Translation 表才是**字节**——按字节读字符串曾把 "Microsoft Edge"（15 含 null）砍成 "Microso"。`file_description_reads_the_whole_string` 用真文件钉住这一点。
  - **它跟随窗口**：浏览器换标签 rail/中心就换名，这是有意的行为（与音量混合器一致），所以 `sessionSignature` **故意不含 display_name**——换标题不是"进程列表变化"，不许写日志。别把它加回签名。
  - **它不进任何键**：路由、记忆（route-memory.json）、源电平、固定端点全部按 exe；dock 的句子、舞台中心、左栏首行用显示名，左栏第二行在显示名与 exe 不同时**保留 exe**（`rail.pid` 前缀），因为用户对着托盘图标和任务管理器时认的是 exe。`exe_path` 只在 Rust 内部装配用，`skip_serializing`，前端永不收路径。
- **图标按 exe 取、按 exe 问**：`get_process_icon(pid)` 在 Rust 侧自己解析镜像路径（`QueryFullProcessImageNameW`——`GetProcessImageFileNameA` 给的设备路径 shell 不认），`SHGetFileInfoW` → `GetIconInfo` → `GetDIBits` 解成 RGBA（有 alpha 用 alpha，老图标用 AND mask 兜底），base64 过线。**Rust 侧按路径只缓存命中**：命中的提取不该重复付钱；**miss 不缓存**——miss 覆盖的失败（进程正在退出、文件正在更新、shell 输掉一次竞态）恰恰是下一次询问要迈过去的，把 miss 钉死等于把一次瞬时损失变成整场没有图标（Cookie Clicker 就是这么丢的图标）。失败的提取很便宜，询问节奏又是事件驱动，无需限流。
  - ⚠️ **一次只按 exe 发一个询问**（`iconsInFlight`）：Electron 游戏一个 exe 挂四个会话，按会话问就是四个并发询问抢写 `iconByExe` 的同一个键——中途死掉的那个 pid（Electron 子进程随时重启）最后落地 null，把三个好答案全踩掉。每轮刷新每个 exe 只用第一个会话的 pid 问一次。
  - 前端 `iconByExe`（exe -> data URL | null）由 `loadMissingIcons` 在 `refreshSessions` 之后**火后不管**地补：列表必须先出现，图标后到。**data URL 是终态**，永不再问；**null 与「还没问」都会在后续刷新再问**——最能解释"图标曾经有、后来没了"的失败就是问的那一瞬间 pid 正在死，下一轮刷新自然补上。
  - 图标**不进** `audio-changed` / `list_sessions` 载荷（那两份每次刷新都发，塞像素是白费）；canvas 转换（`lib/icons.ts`）失败返回 null，不许把图标变成一条错误路径。e2e 假桥按 exe 名哈希出确定性的 8×8 色块，走的是真转换路径。
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
- 三种回调缺一不可：`IMMNotificationClient`（端点增删/默认切换/属性变化）、`IAudioSessionNotification`（**只报新建**）、`IAudioSessionEvents::OnStateChanged`（会话消亡**与声活动**）。少了最后一种，进程列表会永远留着早就停止播放的程序。`Inactive`（暂停但会话还在）**不能**当成退出处理，否则暂停一下就从列表消失。
  - `OnStateChanged` 的 Active/Inactive 转换走**独立事件** `session-activity`（pid, active），不并入 `audio-changed`、**不触发重新枚举**：会话安静不是列表变化，而舞台上的流动要「这一刻」的消息，不是下一次枚举的消息。批处理时逐条转发（一个程序快速开关流时，旧状态不得覆盖新状态）；只含状态消息的批次跳过 `sync()`。
  - 回调对象里必须**在注册时**存下 pid（`SessionEvents.pid`，读不出来存 0 并丢弃该 pid 的状态事件）——状态回调本身不带身份。`Expired` 的语义与路径不变。
  - 前端 `soundingPids` 是**纯显示状态**（辐条流动、脉冲环、标题栏计数），路由逻辑一个字都不读它；每次 `refreshSessions` 按会话列表的 `playing` 标志**重建**（列表是权威），事件在两次刷新之间补瞬时的转换。`AudioSession.playing`（枚举时是否有任一会话 Active，按 pid 跨设备取 OR）是它的种子。
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
- **这套界面是液态玻璃做的**：程序行、舞台上的圆盘与枢纽、底部操作条、Toast、弹窗，凡是"浮起来"的东西都穿 `--glass*`
  那一组令牌。液态玻璃 = 一块**厚透镜**，不是磨砂片：它保持通透（填充 alpha 很低，靠 `--glass-filter` 的 blur+saturate+brightness 折射背后的光）、
  顶部有一枚**紧而亮的高光**（光源的镜面反射，`--glass-specular*` 的第一层 radial）、底部有一道**焦散亮线**与** trapped 在内部的光池**
  （`--glass-specular*` 的第二层 + `--glass-rim*` 的 inset 底部两条）、**整圈 rim catch 一条细亮边**（`--glass-rim*` 的 `inset 0 0 0 1px`），
  再加**分层影子**（`--glass-shadow` = 接触/中层/环境）。这四件——高光、焦散+光池、rim、分层影——缺一件就退回磨砂塑料；
  一团均匀 alpha 填充 + 一团均匀软影就是贴纸。lit discs 的 inline `box-shadow` 引 `--glass-rim` / `--glass-shadow` 这两个令牌，别各写一份。
  **第二种厚度是同一种玻璃的薄片**（`.glass-thin`）：没接线的设备圆盘、没有计划的中心枢纽用更少的填充、更淡的 rim、只留接触影，
  贴着表面；于是"厚而亮的透镜"这个语义只留给正在生效的东西。别把 idle 也改成 `.glass-strong`。
  ⚠️ **`backdrop-filter` 底下必须有东西可折射**：App 根节点那层 `.aurora`（三个推到失焦之外的光池）存在的唯一理由就是这个——
  对着一块纯色做模糊，出来的是磨砂塑料。光池要**保持分离**（尺寸/位置见 `.aurora`）：糊成整片均匀渐变后，每块玻璃折射到的颜色都一样，折射就没了。
  极光**静止**（画一次，永不重绘）：它可以存在，但它不许动。极光上另覆一层**静态颗粒**（`.grain`，overlay 混合）——
  这么平滑的渐变不带颗粒就是矢量渐变，矢量渐变读起来就是塑料；颗粒只调制底下的光，自己不动。
- **低配档（`html.glass-lite`，2026-10-04 起）**：同一块玻璃**去掉折射**的档位。判定与开关在 `lib/glassLite.ts`：
  `aar-glass-lite`（localStorage）存用户的显式选择；没有选择时，弱硬件（`hardwareConcurrency ≤ 4` 或 `deviceMemory ≤ 4`）
  或 Windows 关闭「透明效果」（`prefers-reduced-transparency`）**自动启用**。`index.html` 的启动脚本在**首帧之前**就把类套上
  （与主题同一条规矩：不许先画一帧模糊再变实底），它和 TS 侧是两份逻辑，改判定必须两处同步。
  - 档位的内容只有三件事：`--glass-filter` 归 `none`（亮/暗两份覆盖令牌在 `styles/index.css`）、`--glass-shadow` 少一层环境影、
    高光**不再跟指针**（`useGlassSpecular` 逐事件读 `isGlassLite()`，所以运行中切换立即生效）。填充换成**近实底**，
    由它接替 blur 保住可读性——面板读作实心亚克力，rim 与 specular 留着（渐变和 inset 阴影是涂画，不是采样，不花钱）。
  - ⚠️ **玻璃的大头就是 `backdrop-filter`**：它每帧重采样面板背后的所有内容，任何盖在玻璃上的动画都在付这笔钱。
    往低配档里留一个"小一点的 blur"没有意义（没有便宜的 blur）；同理**禁止在组件里手写 `backdrop-blur-*`**
    （Tailwind 工具类绕过令牌，低配档管不住它）——所有玻璃面必须走 `.glass*` 类。
- **角色三色**（`--type-*`）只属于舞台：**同一个颜色画三处**（圆盘上的环 / 到它的辐条 / 角色词），所以它们没有 `-hover` 之类的变体，
  也不许拿去给别的东西上色。三种角色就是全部，**没有"已选未应用"那一色**：那个区别由底部操作条的那句话承担，不由颜色承担。
- **圆角是阶梯，不是随手取的数**（`tailwind.config.ts` 的 `borderRadius`）：`window 40 → panel 32 → card 26 → ctl 20 → seg 17`。
  相邻两级的差 ≈ 它们之间的内边距，这才是"连续曲率"读起来连续的原因；层级务必取自这一串值（容器大、控件小），别在调用点写 `rounded-[13px]`。
  阶梯只管**停着的矩形平面**（设置页的纸、弹窗）。**浮起来的东西是胶囊或真圆**：dock、toast、rail 的选中与搜索、dock 里的按钮一律 `rounded-full`；
  同心圆家族（hub、设备圆盘）是**真圆**——`rounded-full` 且**不加** `.squircle`，因为 `corner-shape: squircle` 会把满半径渲染成超椭圆（圆角方块），
  一整圈方块站在圆轨道上会把"同心圆"读成"方块摆成圈"。`.squircle` 只留给矩形平面做连续曲率，不支持时退化成普通圆角。
- `.con-ring*` 是同心圆指示器的一族：外环（描边）说"它是什么"，`::after` 的内芯说"它在不正在响"，中间那一圈什么都不画是必须的——
  没有那圈空就读不出同心，变成一个点加一块糊掉的东西。`-live::before` 那圈扩散同样是**有信息**的循环，因此与辐条一样必须走 `useLiveness` 闸门。

```css
:root {
  --bg-primary: #e4eaf1;      /* 窗口那层底：所有玻璃浮在它上面 */
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

  --surface: #ffffff;         /* 设置页那张纸 */
  --surface-sunken: #f2f3f5;
  --surface-raised: #ffffff;
  --surface-hover: rgba(24, 24, 27, 0.035);
  --hairline: #e6e6ea;        /* 行与行、块与块之间的分隔 */
  --hairline-strong: #d4d4da;

  /* 液态玻璃：低 alpha 通透填充 + blur/saturate/brightness 折射 + 顶部紧高光与底部焦散
     （--glass-specular）+ 整圈 rim/顶部热线/底部焦散线/内部光池（--glass-rim）+ 三层影子。
     亮色下填充 30%，strong 42%。 */
  --glass: rgba(255, 255, 255, 0.3);
  --glass-strong: rgba(255, 255, 255, 0.42);
  --glass-border: rgba(255, 255, 255, 0.5);
  --glass-specular: radial-gradient(140% 90% at 50% -18%, rgba(255,255,255,.6), rgba(255,255,255,.14) 42%, rgba(255,255,255,0) 64%), linear-gradient(0deg, rgba(255,255,255,.28), rgba(255,255,255,0) 34%);
  --glass-rim: inset 0 0 0 1px rgba(255,255,255,.4), inset 0 1px 0 rgba(255,255,255,.9), inset 0 -1px 0 rgba(255,255,255,.55), inset 0 -16px 30px -16px rgba(255,255,255,.5);
  --glass-shadow: 0 1px 2px rgba(24,40,66,.12), 0 8px 24px rgba(24,40,66,.14), 0 24px 60px rgba(24,40,66,.14);
  --glass-filter: blur(18px) saturate(190%) brightness(1.05);
  /* 同一种玻璃的薄片（idle 圆盘、无计划的枢纽）。 */
  --glass-thin-bg: rgba(255, 255, 255, 0.16);
  --glass-thin-rim: inset 0 0 0 1px rgba(255,255,255,.3), inset 0 1px 0 rgba(255,255,255,.5);
  --grain-alpha: 0.04;        /* 覆在极光上的静态颗粒 */

  /* 给玻璃折射的光。三个保持分离的光池（糊成一片折射就没了），静态。 */
  --spot-1: rgba(34, 211, 238, 0.48);
  --spot-2: rgba(45, 212, 191, 0.36);
  --spot-3: rgba(251, 191, 36, 0.26);

  /* 舞台上的三种角色（只有这三种，没有第四种）。 */
  --type-primary: #0891b2;
  --type-mirror: #0f766e;     /* 与 primary 邻近的色相，不是第二个 accent */
  --type-idle: #94a3b8;

  --accent-rgb: 8 145 178;
  --error-rgb: 239 68 68;
  --bg-tertiary-rgb: 232 232 236;
  --text-muted-rgb: 113 113 122;
  --hairline-rgb: 230 230 234;
  --surface-rgb: 255 255 255;
  --type-primary-rgb: 8 145 178;
  --type-mirror-rgb: 15 118 110;
  --type-idle-rgb: 148 163 184;
}
.dark {
  --bg-primary: #05080c;
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

  --surface: #12151a;
  --surface-sunken: #0e1114;
  --surface-raised: #161c24;
  --surface-hover: rgba(255, 255, 255, 0.035);
  --hairline: #23272e;
  --hairline-strong: #2e3742;

  /* 暗色下的同一块透镜：填充几乎不加白，玻璃完全靠它catch的光读出来——更冷更紧的顶部
     高光、底部焦散与内部光池、整圈 rim；否则面板就是一块比背景略亮的灰矩形。 */
  --glass: rgba(255, 255, 255, 0.07);
  --glass-strong: rgba(255, 255, 255, 0.12);
  --glass-border: rgba(255, 255, 255, 0.16);
  --glass-specular: radial-gradient(140% 90% at 50% -18%, rgba(255,255,255,.22), rgba(255,255,255,.06) 42%, rgba(255,255,255,0) 64%), linear-gradient(0deg, rgba(255,255,255,.1), rgba(255,255,255,0) 34%);
  --glass-rim: inset 0 0 0 1px rgba(255,255,255,.14), inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(255,255,255,.16), inset 0 -16px 30px -16px rgba(255,255,255,.14);
  --glass-shadow: 0 1px 2px rgba(0,0,0,.5), 0 10px 28px rgba(0,0,0,.45), 0 28px 64px rgba(0,0,0,.5);
  --glass-filter: blur(18px) saturate(180%);
  --glass-thin-bg: rgba(255, 255, 255, 0.04);
  --glass-thin-rim: inset 0 0 0 1px rgba(255,255,255,.08), inset 0 1px 0 rgba(255,255,255,.12);
  --grain-alpha: 0.06;

  /* 同一批光池，冷却并分离：amber 压低，否则在近黑底上它把青色洗成橄榄色。 */
  --spot-1: rgba(34, 211, 238, 0.4);
  --spot-2: rgba(45, 212, 191, 0.26);
  --spot-3: rgba(251, 191, 36, 0.13);

  --type-primary: #22d3ee;
  --type-mirror: #14b8a6;
  --type-idle: #64748b;

  --accent-rgb: 34 211 238;
  --error-rgb: 248 113 113;
  --bg-tertiary-rgb: 39 39 42;
  --text-muted-rgb: 161 161 170;
  --hairline-rgb: 35 39 46;
  --surface-rgb: 18 21 26;
  --type-primary-rgb: 34 211 238;
  --type-mirror-rgb: 20 184 166;
  --type-idle-rgb: 100 116 139;
}
```

---

## 同心圆舞台 UI 规范（2026-10-03 改版，改动前必读）

路由页是一张**同心圆舞台**：**中心是那个程序**（`Hub`），**每台输出设备是环绕它的一枚玻璃圆盘**（`Satellite`），
中心轮缘到某枚亮起的圆盘轮缘之间那根辐条**就是**路由的这一段。这一屏回答的是「**这个程序的声音正往哪儿去**」——
亮起的那些圆盘本身就是答案，眼睛不必先读完一行列头才知道自己在看什么。

视觉语言是**液态玻璃 + 连续曲率圆角 + 同心圆**（`.glass` / `.squircle` / `Ring`；令牌见「主题系统」）。
同心圆不是装饰，它是这套界面的字母：**外环说「它是什么」**（系统直放 / 副本 / 没参与），**内芯说「它在不正在响」**，
两者之间那一圈必须留空——没有那圈空就读不出同心，变成"一个点加一块糊掉的东西"。
整张舞台的词汇量就这么多，剩下的交给位置和底部那一句话。

### 为什么是这个形状（以及为什么这次不算①复发）

历次改版各有各的复活风险，逐条写明，别把删过的东西再拿回来：

| 版本 | 内容 | 现状 |
|------|------|------|
| ① 液态玻璃 + 同心圆舞台 + 胶囊节点 | `ConcentricRouter` / `DeviceAnnotation` / `OutputStatusBar` / `useFitScale` / `useDecorativeMotion` | ①的**形状**在这一版回来了，但只回来形状：装饰循环、自动缩放、当年的节点胶囊都没有回来 |
| ② 路由树 | `RouteFlow` / `RouteSubject` | 已删，不要复活：同一批设备讲两遍，两遍的排序依据还不同 |
| ③ 扁平编辑器式 + 设备表格 | `DeviceTable` | 已删：表格说得出路由由什么组成，说不出「流向」 |
| ④ 节点画布 | `RouteCanvas` / `EdgeLayer` / `SourceNode` / `DeviceNode` / `RouteConfirmCapsule` / `lib/canvas.ts` / `--canvas-grid*` / `--node*` | 已被舞台取代。**辐条留下来了**——它说的仍然是方向，只是两头从两只矩形节点换成了中心与圆盘 |

①当年被删掉的理由是"用位置去说连接：设备围着中心排一圈，谁连到谁要靠推理"。这一版是**解决**了那条理由，不是绕过它：
**中心永远只有一个程序，而且它的名字就写在中心**。于是"谁连到谁"不再需要推理——先看中间那个名字，再看哪几枚盘子亮着。
多个程序这件事归左栏（`ProgramRail`）：列表擅长说"有一群"，环形只说"这一个"。

### 计划与事实（`drawn` / `live`）

- `drawn = selectedDeviceIds` 是**计划**，`live = routedPids[pid]` 是**事实**。选中一个程序时，store 用事实（无路由时用系统默认设备）预填计划，
  所以刚选中时屏幕上出现的是现实；动过手之后出现的是待办的改动。
- ⚠️ **舞台不许自称计划是事实**，也不许给"已选未应用"发明第四种颜色：那个区别由**底部操作条那句话**承担
  （"将从 X 出来" vs "已经从 X 出来"）。把两套真相塞进同一枚环的颜色里，用户没有义务猜哪个是真的。
- **辐条只在三者重合时流动**：画出来的 == 正在生效的（`drawn` 与 `live` 等长同序）&& 程序在响 && `useLiveness()` 放行。

### 舞台几何（`lib/stage.ts`）

`STAGE_W(620)` / `STAGE_H(460)` / `HUB_D(120)` / `DISC_D(76)` / `ORBIT_R(162)` 是**唯一的**尺寸来源，
由 `stageCentre()`、`satellite(index, count)`（从 12 点起顺时针均匀分布）、`spoke(angle)`（中心轮缘 → 圆盘轮缘）算出位置与辐条两端。
组件用 `style` 从这些常量取宽高与坐标，**不要**改成 Tailwind 的 `w-[…]`：尺寸与角度在两处各写一份，辐条迟早会离开圆盘。

同一条理由决定了这里**没有拖动、没有平移、没有缩放**：位置由路由顺序（数组的先后）决定 → 几何是算术 → 不需要 ResizeObserver，
也不需要在每次布局后重算端点；`getBoundingClientRect` 在这里会让每根辐条比每段弹簧晚一帧。
真要加拖动，就必须先把几何换成测量、每次重排后重算端点、并在动画期间钉住"被测到的那一帧"——
换来的是让几台桌面输出设备能被摆成自定义布局。不值得。

⚠️ **尺寸有预算**：620×460 是应用在 900px 默认窗口下工作区的实测尺寸，**低于它滚动（舞台自己 `overflow-auto`），从不压缩**。
调 `ORBIT_R` / `DISC_D` 之前按 `ORBIT_R + DISC_D/2 + 名字一行(约 15px) + 副本的两组 ± 行(约 36px)` 重算垂直方向：
底部那枚盘子最容易先被切掉，因为它下面还挂着名字和调音行。

### 三种角色（`roleOf` / `TONE`）

`primary`（路由里的第一台，由 Windows 自己直接播放）/ `mirror`（本程序的复制引擎送过去的那份副本）/
`idle`（没有任何路由经过它——大多数设备大多数时候）。**同一个颜色画三处**：圆盘里那枚 `Ring`、通向它的辐条、名字下面那个角色词。

- ⚠️ `TONE` 的类名必须是**字面量**：Tailwind 扫的是源码文本，运行时拼出来的类永远不会生成——`bg-accent-muted/50` 就是这么悄悄死掉的。
  同理 `--type-*` 都有 `-rgb` 镜像通道，透明修饰符（`bg-type-primary/[0.07]`）才有输出。
- `primary` = accent：accent 本来就是"属于路由的那部分"的记号。
- `mirror` = accent 的**邻近色相**（teal），不是第二个 accent：它和 primary 是同一件事的两半，两个不相干的颜色会说它们不相干。
- `idle` = slate，**既不上底纹也不发辉光，也没有辐条**——硬件没有接到任何东西，画"没接"的办法就是什么都不画。
  材料上它是**同一种玻璃的薄片**（`.glass-thin`，见「主题系统」）：更通透、rim 更淡、只留接触影，贴着表面；
  因为"厚而亮的透镜"这个语义只留给正在生效的圆盘。同一个道理，没有计划的中心枢纽也是薄片，有了计划才浮成 `.glass-strong`。
- `bloom(role)` 走 inline style 而不是工具类：辉光色必须从主题通道取（跟着亮/暗两套走），而它只是一个属性，不是一种值得命名的形状。

### 圆盘（`Satellite`）

- 可点的是**圆盘本身**（`motion.button`，`aria-pressed={lit}`、`aria-label={name}`、`title` 都是设备名），
  按压走 `SPRING_TAP`，悬停与 `focus-visible` 用 `border-accent/60` + `ring-2`。
- ⚠️ 名字行与角色词行都在**圆盘外面**（按钮之外）：控件里不能嵌控件，键盘够不到。
  容器才挂 `data-device-row`，e2e 用 `aria-label` 取按钮、用容器读整行。
- **角色词那一行无论有没有字都占位**（`minHeight: 12`）：只有参与路由的才有词，不占位的话一列名字就没有共同基线。
  空闲设备在同一位置让给 `System default`——一个位置，一种说法。
- ⚠️ **路由永不为空**：`drawn.length === 1 && drawn[0] === device.id` 时点击被忽略（守卫在最前端，不是靠后端兜底）。
  "一个程序没有地方可以出声"不是这个应用提供的状态。
- **没有「一台 / 多台」模式开关**：点圆盘就是开关，第一个被选中的成为主设备，之后加的都是副本。这是一次选择，不是一个菜单里的选项。

### 动效编排（2026-10-03 微交互层，同样只报告状态）

舞台上每个会动的东西都对应一件刚发生的事，动效曲线只用 `lib/motion.ts` 的共享曲线（`SPRING_ARRIVE` 入场、`RIPPLE` 涟漪）：

- **按压是弹性形变，不是等比缩放**：圆盘与 Apply 按下时 `scaleX` 涨 / `scaleY` 压（一滴液体被按扁），松手弹回真圆；等比缩小读起来像贴纸被揭起来。
- **同心圆涟漪**：按下某枚圆盘时从它发出一圈与它同心的环，扩到约 2.2 倍并淡出（`RIPPLE`，tween 不走 spring——波是离开的，不该回弹）。
  一次性、按一次发一次，**不是常驻循环**；没改变任何事的按（路由只剩一台时点它）不发涟漪。
- **玻璃的高光跟着指针走**：`useGlassSpecular()` 用一个委托 `pointermove` 把悬停面板的局部指针位置写进 `--gx/--gy`，
  `--glass-specular` 的那枚 radial 就放在那里——透镜catch移动的光源，这是液态玻璃区别于"贴了一张高光贴图"的关键。
  指针离开即复位回顶部；`prefers-reduced-motion` 下根本不挂监听（滑动的高光是动效）。

- **圆盘从中心抵达**：`Satellite` 的入场是 `approach(index, count)`（从中心沿自身方位角退回 34% 处）+ 按 index 逐个延迟（封顶 0.24s）——
  环是**顺时针组装出来的**，不是整圈同时闪现。只有首次挂载播放：设备热插拔时只有新盘子动。
- **辐条是长出来的**：`motion.line` 动画 `x2/y2` 从中心轮缘长到圆盘轮缘，撤下时缩回去——"接上了 / 断开了"是看得见的动作。
  `AnimatePresence initial={false}`：页面刚打开时辐条静态就位，只有之后新出现的才有入场戏。
- **词与数字都是"替换"不是"改写"**：角色词、hub 里的程序名、dock 那句话都用 `AnimatePresence mode="wait"` 换场（FADE + 4–5px 位移）；
  副本的延迟/音量数值用 `mode="popLayout"` 纵向滚动。句子被原地改写没人会重读。
- **hub 外圈虚线环**（`HUB_HALO_R`）：空闲时 hairline，有计划时换 accent 色——两层圆交叉淡入而不是动画颜色（颜色插值会脱离主题令牌）。
- **空闲圆盘退后**：`animate` 的 opacity 目标是 `lit ? 1 : 0.72`，悬停任何圆盘都补足到 1 并放大 1.05；悬停还有一圈 `border-accent/45` 的外环以 opacity 淡入（不动阴影）。
- **左栏选中是一块会滑的玻璃**：`layoutId="rail-selection"` 挂在 subject 行的高亮上，换选时整块玻璃滑过去；加入批量的行用静态 `bg-accent/[0.07]`。
  行本身带 `layout`——程序开始/停止发声、路由排序变化时，行**移动**到新位置而不是重画。
- ⚠️ 两条硬线不变：**唯一的常驻循环仍是声流虚线与在响的脉冲环**，且仍被 `useLiveness` 看住；入场/悬停动效交给 `MotionConfig reducedMotion="user"`。
  给 dock、圆盘、± 按钮加的 `whileTap`/`whileHover` 一律用共享曲线，不许在调用点现调。

### 延迟与音量为什么只挂在副本上

路由里的第一台设备由系统**自己**播放，那条路上没有一个属于我们的流——没有东西可以被压后，也没有东西可以被衰减。
所以 `Tuner` 只在 `role === 'mirror' && drawn.length > 1`（确实有引擎在跑）时出现：
这是**结构性**的不给控件，不是给一个变淡的控件——变淡会被读成"以后会生效"。

- **只有按钮，不能拖、不能滚**：这两个数改变的是此刻听到的东西；手指搭在列表上一滑就把二十台设备的响度全改掉，这个错不该能犯。
  音量固定步长 5%（`VOLUME_STEP`），延迟走设置页的 `delayStepMs` 并在 `±delayRangeMs` 夹住（`atMin` / `atMax` 时禁用对应方向）。
- ⚠️ **实测延迟仍然只在 tooltip 里**（`deviceLatency.reading`，挂在延迟那一行的 `title` 上）：两个数字隔着几个像素并排，
  会被读成一个坏掉的数。它连 accent 都不穿——它是读数不是控件。

### 辐条

- 一张 `<svg>` 画完所有辐条，垫在圆盘下面（一条辐条不属于它两头任何一个东西）。
  每条挂 `data-wire="{pid}:{deviceId}"`，流动时另有 `data-live="true"`，e2e 按这个键找。
  静止 `opacity 0.6`、流动 `1`；一根 3px 的清脆直线就够了，**没有**叠一层更宽更淡的假辉光。
- **流动 = 用一段缓慢移动的虚线替换那条实线**（`.stage-flow`，`stroke-dasharray: 3 9`，一个周期 12px ≈ 0.5s）。
  ⚠️ **这是 CSS keyframes 而不是 Motion，是「禁止手写 @keyframes」记录在案的唯一例外**：Motion 会用 JS 每帧驱动 offset，
  而 CSS 动画交给浏览器的动画机制，闸门开合（挂载 / 卸载）零成本。媒体查询里的 `prefers-reduced-motion` 是**第二道**栅栏，不是唯一一道。
- ⚠️ **闸门是卸载式的，不是暂停式的**：窗口隐藏 / 失焦 / 系统减动效 / 程序静音，任一不满足，流动层就**不存在**——
  静止舞台的重绘必须是零。这条是当初「线不许动」的硬约束：改版买走了例外，买不走约束本身。
  同一条约束也管 `.con-ring-live` 那圈脉冲——**左栏的行也过了 `useLiveness`**，新增脉冲环时别漏掉这道闸。
- **流速不随音量**：那需要引擎发布逐帧电平，而轮询电平的唤醒代价高于效果本身。已知取舍，别顺手加上。
- e2e 坑：只有两台设备时辐条正好竖直，包围盒宽度为 0，`toBeVisible()` 会失败——**数元素**（`toHaveCount(1)`），别测可见性。

### 中心（`Hub`）

一枚 `HUB_D` 的大玻璃圆盘：里面是一枚 `Ring`（有计划时 `main`，否则 `idle`）+ 程序名 + 一行"在响 / 没在响"。
它**不可点**：指着这一群里的另一个由左栏负责，指着"中心自己"没有意义。容器挂 `data-source-node`。
`SourceLevelDial`（每程序电平环）只在 `drawn.length > 1` 时挂上来——与副本那组按钮是同一条规则：单设备路由没有引擎。

### 底部操作条（`ActionDock`）

工作区底部一层 `absolute inset-x-0 bottom-4` 的 `pointer-events-none` 居中层，**浮着、不占布局、不推动任何东西**。
内容只有一句话 + `Apply`，以及一条竖 hairline 后面的破坏性动作与 `Revert`。

- `alreadyApplied()`： staged 与正在播放的完全一样时不问——刚路由完、或重新选中一个已路由的程序，
  都属于"你正在看着答案，不该再问你一遍"。
- `Revert` = 重新 `selectProcess(pid)`：store 在选中时会把事实读回计划，所以"丢掉我的选择"和"重新选中它"是同一个操作。
- 「回到系统默认」用 `ConfirmButton`（Escape / 失焦 / 超时解除），作用域 = 选中的已路由程序；
  **没有选中时 = 全部已路由程序**——那是唯一能走出"看不见的路由"的出口。
- ⚠️ **`Escape` 的捕获阶段监听必须跟着可见性注册与注销**（现在的锚点换了组件，规矩没变）：常驻注册会把整个窗口的 Escape 全吞掉，
  搜索框按 Esc 清空会失效（这个 bug 出现过，由 e2e 抓出）。

### 左栏（`ProgramRail`）

- 每行：一枚 `Ring`（有路由是 `main`，在响且闸门放行时挂 `live`）+ 程序名 + 第二行 `PID xxx`（**只有已路由的行**才追加 `· 设备名 +n`）。
  行与行之间**没有 hairline**——靠自己的形状与留白就够分隔；选中态是整行变成 `glass-strong`。
- **`MiniToggle` 取代 Ctrl+点击**：行末那颗圆形小开关写着"这个程序也一起改"，**看得见的功能才算存在**。
  Ctrl/Cmd + 点击名称仍然做同一件事，但没有任何东西依赖用户知道那个修饰键。
- 排序：已路由的排到最前，组内保持枚举顺序（**稳定**排序）——否则行会在每次刷新时互相换位，鼠标底下的目标就跑了。
- 搜索：`query` 是组件本地 `useState`，按 `exe_name` 过滤，`Escape` 清空并失焦。无匹配 ≠ 没有程序在放音（`rail.noMatch` / `rail.empty` 是两句）。
- 停止路由的 ✕ 只在**行悬停 / 焦点进入**时出现，且是 `ConfirmButton`：每行都挂个叉，列表就读成一份待删除清单。

### 布局与其余规矩

- `App` 根节点 `relative isolate` + 一层 `.aurora`（`-z-10`，静态），**标题栏透明**——它是同一扇窗的一部分，不是贴在窗上的一块。
  下面是 `aside`（236px + `border-r border-line`）＋ `main`（`relative`，给底部操作条一个锚点）＋ `UnderlineTabs`（Routing / Activity）。
  标签页下划线用 `layoutId` 迁移，**不是胶囊**。
- **路由只由舞台表达**：辐条就是路由。**别在别处再画第二份**（树、状态条、文字摘要）——同一件事说两遍会像两套状态
  （`OutputStatusBar` 就是这样被删掉的）。
- **accent 只用来标记"属于路由的那部分"**：左栏的选中行、`primary` 那一环与它的辐条、底部那个动作词。角色词按角色上色（那是编码本身）。
- 数字与标识符（PID、毫秒、百分比、版本号、exe 名）用 `font-mono tabular-nums`：等宽是这类界面里"这是数据"的记号。
- **误操作防护**（几条一起才算完整）：① 舞台永远只是提案，改动必须按 Apply；② "也改这个"有看得见的开关，不依赖 Ctrl；
  ③ 破坏性且影响全局的动作用 `ConfirmButton`；④ 路由后 Toast 给 8 秒撤销（全项目唯一的撤销入口）。
  另外一条是结构性的：路由不可能被点成空的。
- **i18n**：文案分组是 `rail` / `stage` / `dock`（取代 `processList` / `canvas` / `deviceTable` / `router` / `statusBar`），
  两组 locale 的键集合、占位符与非空由 `src/i18n/locales.test.ts` 的对称测试保护。
  句子说人话，避开"路由 / 镜像 / 主设备"这类内部词（`dock.preview` 是「「{{process}}」的声音将从 {{device}} 出来」，而不是"该进程已镜像至 X"）。
- **禁止**：胶囊状的**标签页**（标签仍是下划线，`layoutId` 迁移——胶囊标签是上面那一版的反面；但浮动的**控件**是胶囊，见「圆角」）、
  常驻装饰循环（背景漂移、轨道环；**辐条流动与脉冲环是唯二的例外，且必须走卸载式闸门**）、舞台的拖动·平移·缩放、第二份路由摘要、
  把延迟/音量画到主设备上（包括"变淡地画"）、给"待确认"发明第四种颜色、给同心圆家族加 `.squircle`（会变成方块）。
- **动效**：全部取自 `lib/motion.ts`——`SPRING_TAP`（圆盘按压、行内的微交互）/ `FADE`（纯透明度入场）/
  `SPRING_GLIDE`（有位移的视图切换），**不要在调用点现调参数**：邻居之间弹得不一样看着像 bug，不像设计。

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
- [ ] 显示名：有窗口的程序在左栏首行、舞台中心、操作条句子里显示**可见**窗口标题（浏览器换标签跟着换名且不写「进程列表变化」日志）；托盘常驻或 UI 在别的进程里的程序显示版本资源描述（steam.exe → "Steam"，不是隐藏窗口的「无标题」；msedge.exe → "Microsoft Edge"，不是被砍半的 "Microso"），两者都没有时回退 exe 名；左栏第二行在两者不同时保留 exe；搜索两个名字都命中
- [ ] 图标：左栏每行与中心显示 exe 图标（同 exe 的多个进程只有一份，也只发一次询问）；像素异步到达时行不移位（占位槽尺寸固定）；问的瞬间 pid 死掉或提取一时失败，后续刷新自动补问、图标自己回来；真正无图标的程序稳定显示首字母，不报错
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
- [ ] 同心圆舞台：选中一个程序后它在中心（名字写在圆盘里），每台输出设备一枚环绕它的玻璃圆盘；参与路由的那几枚亮着并有辐条连到中心，**没参与的没有任何辐条也没有角色词**；设备名与角色词在圆盘**外面**，所以圆盘本身始终是整个可点的按钮
- [ ] 先替换、后追加：选中一个已路由的程序后**第一次**点另一台设备是替换（只输出到那一台），同一状态下再点别的才是追加成副本；路由里只剩一台时点它被忽略——**路由不可能被点成空的**
- [ ] 底部操作条：一句话说清「谁将从哪里出来」+ Apply，按了才响；画面已经是事实时它不问（只留 Revert 与「回到系统默认」）；`Escape` 不会赖着吃掉搜索框里的同名按键
- [ ] 批次：左栏行末那颗圆形开关能把另一个程序并进这次改动（不知道 Ctrl 也能做）；Ctrl+点击名称做同一件事，两处的状态一致
- [ ] 声流：只有画出来的路线与正在生效的完全一致、且程序在响时，辐条才跑流动虚线；程序一停虚线消失（卸载，不是暂停）；把窗口切到后台或失焦，**辐条与脉冲环都被卸载**，静止界面不产生任何重绘；系统「减少动态效果」开启时同样静止
- [ ] 延迟/音量只挂在副本上：路由 ≥2 台时副本那两组 ± 出现；**主设备没有这组控件**（不是变淡禁用）；延迟按一下走设置页的步进并在 ±range 处禁用对应方向，音量固定 5%
- [ ] 电平环：路由 ≥2 台设备的程序，舞台中心底下带环（拖动/滚轮/键入可改，环随手势走）；单设备路由与未路由的程序没有环；100 时该 exe 不落盘（`source-volumes.json` 里查不到）
- [ ] 标题栏计数：有路由时显示「已路由 n · 在响 m」，m 只数被路由且在响的程序；清空所有路由后计数整条消失
- [ ] 镜像设备失败：让一台正在镜像的设备打不开，该设备从路由徽标里消失并留一行点名它的 error 日志，其余设备继续出声
- [ ] 功耗：路由一个程序到 2–3 台设备后让它静默，`powercfg /energy` 里本进程的唤醒数从约 100×设备数/秒降到个位数；音频恢复时无爆音，停顿后第一声的延迟与连续播放一致
- [ ] 延迟/音量的「能不能调」由结构说明：单设备路由与未路由的设备**看不到**这两组控件，副本上才有；改了立刻生效
- [ ] 实测延迟读数：路由一个程序到 2–3 台设备，副本那组延迟行的 tooltip 显示软件侧延迟且**随延迟补偿变化**；主设备那一格不存在（它没有那组控件）；停掉路由后读数**立刻消失**，不留旧数字
- [ ] 每源电平：路由两个程序到同一组设备，把其中一个调到 <100 或 >100，只有它的响度变（环在舞台中心底下调节；设置页只剩一键对齐）
- [ ] 一键对齐：两个程序同时放音，点「对齐电平」后两条响度接近，且**没在放音的程序原样不动并在日志里被点名**；只有一个程序在放音时提示说的是「只有一个」而不是「没有在放音」
- [ ] 撤销：改路由后撤销回到上一步；撤销一个原本未路由的进程 = 回到未路由；开了自动记忆时，**撤销之后重启该程序不会把撤掉的路由装回来**；手动停掉某条路由后 Toast 不再提供撤销
- [ ] 误操作防护：左栏表头与底部操作条里的「回到系统默认」都需二次确认（Escape / 失焦 / 超时解除）；Toast 退场时不吃掉紧接着的点击
- [ ] 操作条只在有话要说时出现；`Escape` 不被任何常驻监听吞掉——**搜索框里的 `Escape` 仍然能清空搜索**
- [ ] Light/Dark 切换流畅（玻璃两个主题：亮色填充 55% 白、暗色 5.5% 白）
- [ ] 低配档：设置 → 外观里「降低玻璃特效」可开关并持久化（`aar-glass-lite`）；开启后任何 `.glass*` 面板的 `backdrop-filter` 计算值都是 `none`，高光不再跟指针，且运行中切换立即生效；用户没做过选择时，弱硬件（≤4 核 / ≤4GB）或系统关闭透明效果在**首帧之前**就已是低配档
- [ ] 切页与下划线迁移流畅（60fps）；界面静止时（无程序在响、或窗口隐藏/失焦）不产生任何常驻重绘——辐条流动与脉冲环是唯二的主循环，且静止时被卸载
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
