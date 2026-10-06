# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。

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
│       ├── install.rs      # 启动提示：全新安装 / 装过 2.1.0（建窗口之前判定，install-state.json 记版本）
│       ├── single_instance.rs  # 单实例：命名互斥 + 命名事件（第二次启动唤出已有窗口后自行退出）
│       ├── audio/
│       │   ├── mod.rs
│       │   ├── devices.rs      # IMMDeviceEnumerator 设备枚举（渲染 + 捕获两个数据流共用一个走法）
│       │   ├── sessions.rs     # IAudioSessionEnumerator 会话枚举 + 显示名装配（窗口标题 → FileDescription）
│       │   ├── process_meta.rs # 音频之外的进程元数据：盘符形式镜像路径、窗口标题（一次 EnumWindows 扫全表）、FileDescription、图标提取（按路径缓存，含 miss）
│       │   ├── routing.rs      # 每应用端点：槽 25/26 按 (data_flow, role) 写入·释放·读回（null HSTRING = 清除）+ 系统关键进程拦截 + PinnedRoutes（本进程写过的分配，渲染/捕获两本账；停止/退出/重置时归还）
│       │   ├── duplication.rs  # WASAPI 进程回环 → 多设备复制引擎（源静默后停放；见「引擎的唤醒成本」）+ 每源电平估计与增益
│       │   ├── levels.rs       # 每源电平表：各引擎写自己的估算，对齐与诊断都从这里读（只回 1 秒内的读数）
│       │   └── notifications.rs # 变更通知线程 → audio-changed 事件（设备/会话实时刷新）
│       └── config.rs       # 配置持久化（route-memory.json: exe -> 设备列表；device-delays.json: 设备 -> 延迟补偿 ms + delay_range_ms 正负范围上限；device-volumes.json: 设备 -> 份额 %；primary-volumes.json: exe -> 主输出音量 %（会话音量，5–100）；source-volumes.json: exe -> 电平 %（可 >100）；feed-memory.json: exe -> 送入目标 exe 列表；feed-carrier.json: 送入载体（回环端点对）；app-settings.json: close_to_tray）
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── NodeStage.tsx         # 节点看板，也是路由唯一被表达的地方：左中是当前程序（hub 卡），右侧一列去向卡（输出设备 / 其他程序的输入），hub 出脚到去向入脚的那根线就是路由；内含 Inspector（底部调音条：主输出=会话音量，副本=延迟+份额）与添加去向选择器
│   │   ├── ProgramRail.tsx       # 左栏程序列表：每行一个正在出声的程序，行末那颗圆形开关「同时更改此程序的输出」取代了 Ctrl+点击
│   │   ├── StatusBriefing.tsx    # 「直说」按钮 + 现状气泡：点一下就用大白话说清此刻每个程序从哪儿出声；按钮的完整名字放自制的 ui/Tooltip
│   │   ├── SourceLevelDial.tsx   # hub 卡下方的每程序电平环（0–400 %，套 ScrubReadout 的 lead 槽画环），只在多设备路由时挂载
│   │   ├── Toast.tsx             # 瞬态提示：路由与送入改动后提供「撤销」（全项目唯一的撤销入口；两条各有一枚，可同时立着）
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/已记忆路由列表/送入载体/每应用音频重置/后台开关/延迟范围·步进/一键对齐/关于）
│   │   ├── LogPanel.tsx          # 活动记录（下划线标签页的第二页）
│   │   ├── TitleBar.tsx    # 自定义标题栏（透明，看板从它底下过：品牌 + 「已路由 · 播放中」计数 + 设置入口 + 窗口控制）
│   │   ├── StartupWizard.tsx        # 首次启动的全屏向导（四步：欢迎 / 看板读法 / 载体 / 后台习惯；完成、跳过、Escape 都走 ack_startup_notice）
│   │   ├── StartupNoticeDialog.tsx  # 升级提示弹窗（旧版本固定端点警告 + 就地重置；首次启动归 StartupWizard 管）
│   │   └── ui/             # 基础控件
│   │       ├── Ring.tsx                # 同心圆指示器：外环说"它是什么"，内芯说"它在不正在响"；全项目共用这一枚
│   │       ├── ProcessIcon.tsx         # 每程序的 exe 图标槽（数据在 store 的 iconByExe）：像素未到或没有时显示显示名首字母，槽位尺寸固定不移位
│   │       ├── Switch.tsx              # 开关（h-5 w-9）
│   │       ├── UnderlineTabs.tsx       # 下划线标签页（不是胶囊；下划线用 layoutId 迁移）
│   │       ├── SegmentedControl.tsx    # 下划线式分段控件（不是胶囊，也不是 pill track）
│   │       ├── ScrubReadout.tsx        # 通用「数值即控件」（拖动/滚轮/方向键/键入），电平环在用；lead 槽可在数字前挂一个跟随预览值的图形
│   │       ├── StepButton.tsx          # 方形 ± 按钮（h-6 w-6，仅设置页在用）
│   │       ├── Tooltip.tsx             # 自制 tooltip（native `title` 迟、不可样式化、测试不可见）：悬停/聚焦稍作停留即出现；实体底
│   │       ├── ConfirmButton.tsx       # 二次确认按钮（先「确认？」再执行；Escape/失焦/超时解除）
│   │       └── DelayStepper.tsx        # 设置页的延迟行控件（−/数值/+ 方框样式）
│   ├── hooks/              # 自定义 hooks
│   │   ├── useTheme.ts
│   │   ├── useLanguage.ts
│   │   ├── useDelayValue.ts  # 延迟编辑状态（草稿/提交/步进），两个延迟控件共用
│   │   ├── useLiveness.ts    # 声流闸门：窗口可见 + 持有焦点 + 未要求减少动效；三者任一不满足返回 false
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
│   │   ├── stage.ts        # 看板几何：hub/去向卡/来源卡的尺寸与坐标、引脚的坐标、线路径（两端由此算出，不测量）+ 板高随卡数增长 + alreadyApplied（计划是否已是事实）
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
8. **动效只用来报告状态**：动画要说明一件正在发生的事（视图切换、下划线迁移、现状气泡浮出、路由已生效、程序正在出声），纯装饰的无限循环一律不加——日志面板那颗心跳点就是因为一直在眼角闪而改成静止的。
9. **常驻循环只有两个，且都必须被闸门看住**：一是**看板线上的流动虚线**（报告"这个程序此刻正在出声"），二是**同心圆环的脉冲**（报告同一件事）。
   2026-10-01 删掉了那批装饰循环（背景漂移光晕、80s 轨道环、设备脉冲环），连同 `useDecorativeMotion()`；这两层后来被请了回来——
   除此之外仍然一个循环都不许有。闸门（`useLiveness`）是硬约束：窗口不可见、失去焦点、或系统要求减少动效时，这两层都**卸载**（线回到静止灰线、脉冲环不再存在），不是暂停——静止的界面不产生任何重绘。
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
- 路由选择是有序集合（`selectedDeviceIds`）：点击去向卡表达的是**进/出这条路由**（或经「添加去向」加入）；谁是主设备不是"第一次点击"的意外——路由落地（按下 hub 卡）一直按延迟排序（`orderByDelay`，稳定排序，住在 `lib/delay.ts`），看板画的也是这个延迟序，所以主位永远是落地之后真正被系统直连的那台。延迟全为默认 0 时排序稳定、计划自身的顺序说了算——副本角色词上的「设为主输出」（`promoteDevice`，把该设备提到计划首位，随落地生效）就是把这份自由交给用户；延迟补偿严格更大的设备坐上主位会让延迟对不齐（主输出被系统直接播放，软件延迟只能往后加），所以它的角色词不是控件，悬停不出现动作、由 `title` 解释原因。
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
- **记忆的送入同样会自动恢复**（`restoreRememberedFeeds`），规矩与路由恢复同款：等列表与记忆都到位（`refreshSessions` 之后、
  `loadFeeds` 与 `loadFeedCarrier` 之后各调一次，谁最后到谁生效），一个 (源 pid, 目标 exe) 只试一次（`feedRestoreDecided`，同样故意不清理），
  **源正被设备路由占着渲染槽时跳过**（那时只能记成挂起，看板已经这么显示，重启时不必再试一遍）。
- 延迟是**每台设备各自相对系统音频的绝对值**（不是相对某台主设备）：每台设备都可设，主设备（系统直连那台）也能设；
  `duplication.rs` 以「组内延迟最小的设备」为基准，`target_frames()` = 基础 100ms `LATENCY_TARGET_MS` + (自身延迟 − 组内最小值)，
  所以相对差一定被精确还原、绝对值会被归一化到最早的那台（软件延迟只能加不能减）。组内最小值同时包含主设备的值（`primary_delay_ms`）。
- 应用路由时前端按延迟从小到大排序（`orderByDelay`），让延迟最小的设备成为系统直连的主设备；设置页可调 ±1/2/5/10 秒范围与步进（默认 10 ms，`aar-delay-step`），缩小范围时前后端同时钳制越界值。
- 延迟入口是**看板调音条里副本那一行 `−/数值/+`**（`NodeStage` 的 `Inspector`）：签名数值 + 小号 `ms`，
  每按一次走 `delayStepMs`，到 `±delayRangeMs` 的两端时对应方向禁用。**没有拖动、没有滚轮**——这两个数改的是此刻听到的东西。
  设置页另有逐设备列表（`DelayStepper`），用来给**当前没并进这条路由**的设备预设延迟；两处不是一个东西：
  调音条改的是"这条路由里的这一份副本"，设置页改的是"这台设备"。
  ⚠️ 历史上那一套「设备表格的 Delay 列（`COL_DELAY` 宽度常量）+ 横向拖动 + 滚轮 + 键入 + `advancedMode` 显隐」已删，
  **不要复活**：同一个数在两个地方能改，一定有先后之争，而这里没有正确答案。
- 音量有**两个轴**，别混为一谈（2026-10-05 起）：
  - **设备份额**（`device-volumes.json`，设备 -> %）：一台设备作为**副本**时的响度。基准是「副本中最响的一台」——
    `group_max_volume()` 取启用副本的最大值（主设备**不在**基准里：它的响度走会话音量，是程序的属性而非设备的属性，
    混进基准会让每台副本追着一个没有被点击就移动的数字跑）。镜像按 `own / max` 在 `pump_render` 写设备之前缩放；
    软件增益只能衰减，最响的副本无法被压低。0 静音、100 原样（不落盘）。
  - **主输出音量**（`primary-volumes.json`，exe -> %，5–100）：程序的**会话音量**（`ISimpleAudioVolume`，音量混音器里那个滑杆）
    ——唯一能摸到主输出响度的杠杆，因为回环捕获位于会话音量**之后**。引擎对每台副本的增益除以同一因子
    （`session_compensation`；`pump_render` 里源电平 × 份额 × 补偿三者相乘），会话音量在副本的算术里精确相消——
    **动主输出音量只动主输出那一路，副本分毫不动**。下限 5%（`PRIMARY_VOLUME_MIN_PERCENT`；前端 `PRIMARY_VOLUME_MIN`
    是同一字面量的镜像，两处没有东西绑住，改一处必须改另一处）：0 会让捕获流变成真静音，任何增益都无法把副本还回去。
    引擎 start 时认领（先读原值记住）、`stop_route`/应用退出（`ExitRequested`）时归还——会话音量若跟着路由留下，
    程序在所有路径上都会变小声，混音器还会替下一次启动记住它。
  - 采样格式在 `start()` 时从 `WAVEFORMATEX`(可能 extensible) 解析成 `SampleFormat`（float32/float64/PCM 16·24·32），
    认不出的格式**跳过增益**而不是乱改数据；增益为 1.0 时直接短路，常规情况不付任何代价。
  - ⚠️ 2026-09-19 移除的那套「按 exe 压会话音量」与本套的差别就在**补偿**：旧套把会话音量当作平衡机制、所有路径一起变；
    新套把它当作主输出路径的专属音量，副本由引擎等比补回。**仍然禁止**：给未路由的程序调会话音量、
    用会话音量做设备间平衡、绕过 `update_primary_volume` 直接写会话音量。前端入口：副本那行是份额（0–100、步进 5%），
    主设备那行是主输出音量（5–100、步进 5%）。对齐（`align_source_levels`）以实测电平为准——实测含会话音量，
    所以对齐的是主输出路径的响度；主输出音量不同的两个程序对齐后，副本路径可能仍有差别，已知取舍。
- **每源电平是对我们捕获到的音频做的软件增益，不是那个应用的音量**（`source-volumes.json`，**exe -> %**，0–400，100 为原样）。它与设备份额**相乘**施加在同一处（`pump_render` 里的 `apply_gain`），键按**可执行文件名**——与路由归属同一条规则：一个程序可以有好几个会话，电平属于程序。
  - 这是本模块**唯一允许 >1.0** 的增益。设备份额只能衰减，因为设备头上还有硬件音量可拧；而一个程序的音频头上没有东西，比邻居轻就得放大它。`SOURCE_VOLUME_MAX`（约 +12 dB）是上限，再往上噪声底会一起抬起来。
  - ⚠️ 2026-10-05 起这个说法要精确化：**补偿因子**（`session_compensation`，= 100 ÷ 主输出音量）也会超过 1.0——它不是放大程序的音频，而是把会话音量压低的捕获流原样还原，数学上是恒等操作。它与源电平、份额三者相乘。
  - ⚠️ **它不是复活 2026-09-19 删掉的那套**：那是 `ISimpleAudioVolume` 改应用自己的会话音量并落盘，会改变该应用在**所有**路径上的响度；这里是引擎对自己捕获到的字节做乘法，不碰应用、不写应用状态。UI 文案必须说清这一点，否则会被当成同一个东西。也正因如此它**只对正在路由的程序有意义**（没有引擎就没有这条路径），电平环挂在 hub 卡底下、只在 ≥2 台设备时才出现（2026-10-03 起设置页的逐程序列表已删——同一件事不画两遍；设置页只留一键对齐）。
  - 电平表的键是 **(exe, pid)**，出口（`fresh_all`）再按程序折成一份、取**最响的那个窗口**：一个程序可以同时有好几个引擎（浏览器多窗口各路由一次），只按 exe 做键会留下「最后写入的那一个」，把对齐引到一个谁都不是的数字上。
  - **一键对齐**（`align_source_levels`）取「正在路由且在放音」的程序，把每条抬/压到「最响那条 × `ALIGN_HEADROOM`」。每条增益**双重设界**：`SOURCE_VOLUME_MAX` 的绝对上限，以及**该程序自己的实测峰值**（`1 / peak`）。
  - **这个上限的准确含义是「对它被测到的那段素材安全」，不是「永远不削顶」**：增益算一次就落盘并一直用，而峰值是在衰减的估计（`PEAK_RELEASE_MS`），所以一个被测得安静、之后才放响的程序仍可能被放大到削顶。文案与验收条目都必须按这个口径写，**不要**写成「不可能削顶」，否则下一个人会以为有硬保证。也正因为有这层保护，这里**不需要限幅器**。
  - 测得低于 `SILENT_LEVEL`（约 −60 dBFS）的程序**不参与对齐**：它的比值无界，会被夹到上限并**永久存成 400 %**，等着它第一次出声就放大。多源相加的削顶发生在 Windows 的混音里、这边看不见，headroom 只是礼让余量而非保证。
  - ⚠️ **`SOURCE_LEVEL_MAX`（TS）与 `SOURCE_VOLUME_MAX`（Rust）是两处字面量**，没有东西绑住它们——和版本号那三处一样容易漂移。改一处必须改另一处。
  - **没在放音的程序原样不动**并在结果里点名：对着静音做对齐等于对着「没有」做对齐。**读不出格式的程序也不能当成安静**（`measure_chunk` 返回 `None` 而不是 0），否则会被放大。
  - 电平表（`levels.rs`）**只回 1 秒内的读数**：进程回环只在程序真的出声时才给包，安静下来的程序会留着上一次的测量值，而过期读数会被当成「一个安静的程序」——那正是最该避免的误判。
  - **不要**为它加轮询或实时电平表：对齐是一次性动作，结果走日志与存下来的数值。
- **送入（送进另一个程序的输入）自成一类（2.3.0）**：它两端各钉一个端点，所以**选中即生效**、撤销走 Toast（`feedUndo`），
  不像设备路由那样有两段式计划。三态由 `feedLiveness()` 算出来并写在卡上：`live`（送入）/ `suspended`（挂起：源正输出到设备，
  渲染槽被占）/ `no-carrier`（未接通：没配载体）。规则存在 `feed-memory.json`（exe → 目标 exe 列表，与路由记忆是两份、互不依赖），
  载体是 `feed-carrier.json`。**恢复**（`restoreRememberedFeeds`）与路由恢复同规矩：列表/记忆/载体三者谁最后到谁调它，
  一个 (源 pid, 目标 exe) 只试一次（`feedRestoreDecided`），失败不重试、不在每次 Core Audio 变化时刷日志。
  ⚠️ **后端那边渲染与捕获是两个数据流**：`PinnedRoutes` 分两本账，`stop_route` 只清渲染侧，并把被挂起的送入**就地钉回载体**；
  只有"重置每应用音频输出"与退出会两流一起清。
- **延迟与音量在哪台设备上有没有可能生效，现在是结构说了算**。路由 ≥2 台（确实有引擎在跑）时：
  **副本**（`role === 'mirror'`）画两行——延迟 + 份额；**主设备**（`role === 'primary'`）画一行——主输出音量（会话音量，
  副本被补偿，见上一条）；**空闲设备**什么都不画。理由是硬的：延迟在主输出那条路上没有属于我们的流可以被压后；
  音量则在两条路上各有一个真实的杠杆（副本=份额，主输出=会话音量）。
  - 于是旧的说法（"`inactive` 时读数变淡并提示原因"）**依然作废**：变淡的控件会被读成"以后会生效"，而这里永远不会。
    角色只剩 `primary` / `mirror` / `idle` 三个，`lib/engineRole.ts` 与它的 `EngineRole` 枚举已全部删掉，别再搬回来。
  - 主设备的**延迟值**依然有意义：它仍要读、仍要落盘，是整组延迟的基准（`primary_delay_ms`），只是不作为控件。
    主设备的设备份额值不再参与任何计算（它的响度走会话音量）；那份存储值只在它作为副本时生效。
    单设备路由不启动引擎，那种路由没有任何控件：同一条规则，两种表现，不要为它特例盖章。
- **上报的延迟是软件侧的实测值**：`ActiveRoute.latency_ms`（与 `device_ids` 等长同序，主设备在前）给出每台设备**此刻实际在播**的软件侧延迟 = 该设备的管线深度（`target_frames`，含它自己的延迟补偿）+ 端点自报的 `GetStreamLatency`。前端存进 `deviceLatencyMs`（按设备 id），只用在看板调音条里副本那行延迟的 `title` 上（`NodeStage` 的 `Inspector`）——主设备没有那行控件，所以那个数也就不存在。
  - **主设备是 `null`，不是 0**：它由 Windows 直接播放，没有我们自己的流可问；`duplication.rs` 里 `stream_latency_ms == 0` 一律读作「未测量」（初始化即 0，查询失败也是 0），所以别把它当「零延迟」用。
  - **硬件的部分不猜**：编解码 / A2DP 缓冲在用户态不可观测，文案必须写明这是软件侧、实际听到的更晚，不能暗示它是全部声学延迟。
  - **role 与读数要交叉校验**：`deviceLatencyMs` 只在 `reconcileActiveDuplications` 里重建，而 `routedPids` 有多处会改，所以延迟读数只在角色是 `mirror` 时才被当成数——现在由调音条只给 `mirror` 画那行控件来实现，别退回"照常显示再做校验"：停掉路由后会留下一个描述"已经不存在的流"的数字。
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
  - **它不进任何键**：路由、记忆（route-memory.json / feed-memory.json）、源电平、固定端点全部按 exe；hub 卡（及其按钮的 `aria-label`）、左栏首行用显示名，左栏第二行在显示名与 exe 不同时**保留 exe**（`rail.pid` 前缀），因为用户对着托盘图标和任务管理器时认的是 exe。`exe_path` 只在 Rust 内部装配用，`skip_serializing`，前端永不收路径。
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
  - `OnStateChanged` 的 Active/Inactive 转换走**独立事件** `session-activity`（pid, active），不并入 `audio-changed`、**不触发重新枚举**：会话安静不是列表变化，而看板上的流动要「这一刻」的消息，不是下一次枚举的消息。批处理时逐条转发（一个程序快速开关流时，旧状态不得覆盖新状态）；只含状态消息的批次跳过 `sync()`。
  - 回调对象里必须**在注册时**存下 pid（`SessionEvents.pid`，读不出来存 0 并丢弃该 pid 的状态事件）——状态回调本身不带身份。`Expired` 的语义与路径不变。
  - 前端 `soundingPids` 是**纯显示状态**（线上流动、脉冲环、标题栏计数），路由逻辑一个字都不读它；每次 `refreshSessions` 按会话列表的 `playing` 标志**重建**（列表是权威），事件在两次刷新之间补瞬时的转换。`AudioSession.playing`（枚举时是否有任一会话 Active，按 pid 跨设备取 OR）是它的种子。
- 线程启动时必须先 `sync()` 一次：两种回调都只报「变化」，不给已存在的设备/会话预先挂钩子，启动前就在放音的程序永远不会被通知到。
- 一次热插拔会连着发好几个回调（added → default → state → property）。合并在两处做：**后端** drain `rx.try_recv()` 成一批，**前端** 用 `AUDIO_SYNC_DEBOUNCE_MS = 400` 合并 flags（用 `||` 累积，别覆盖，否则会丢掉前一次的一半）。
- 通知触发的刷新是 `refreshDevices(true)` / `refreshSessions(true)`：**只有列表内容真的变了才写日志**（`devicesChanged` / `sessionsChanged`），手动的照旧固定写一行。注意 `refreshSessions` 的可选参数——点击处理器必须 `() => void refreshSessions()`，直接把函数交给 `onClick` 会把 MouseEvent 当成 `true` 传进去。`devices` 分支还会跟一次 `loadCaptureDevices()`：载体选择器列的是捕获侧，回环驱动装上后必须不重启就出现在列表里。通知处理（`syncFromNotification`）末尾还会跟一次 `reconcileActiveDuplications()`：引擎的报数（延迟读数、逐设备角色）没有自己的事件，靠这一次和下面两处才不至于永远停在旧值。
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

首次启动和升级后的首次启动各要说一句话：**全新安装进全屏向导**（`StartupWizard`，四步：欢迎 → 看板怎么读 → 送入载体 → 后台习惯；载体一步复用 `lib/carrierDetect.ts` 的探测，完成/跳过/`Escape` 都走同一条 ack），**装过 2.1.0** 则在弹窗里直接提供「重置每应用音频输出」。升级是警告不是导览，所以升级永远走小弹窗、不走向导。2.1.0 是唯一会把固定端点留在 Windows 里的版本（见上一节；2.1.1 起四条归还路径闭环，从那以后升上来的机器无事可清、**不再弹这个窗**），而应用分不出「2.1.0 留下的」和「用户在音量合成器里手设的」——所以既不静默清理，也不装作没事，而是问一次。

- ⚠️ **判定必须在建窗口之前完成**（`main.rs` 里 `tauri::Builder` 之前），依据是本应用自己的两个目录：`%APPDATA%\<identifier>`（配置文件，只有存过东西才存在）和 `%LOCALAPPDATA%\<identifier>\EBWebView`（WebView2 档案，任何版本跑过一次就有）。挪进 `setup()` 就晚了：这一次启动自己会建出 EBWebView，全新安装会被认成升级。
- 目录取自环境变量而不是 `app.path()`，因为判定时机在 App 存在之前；`identifier` 从 `generate_context!().config()` 读，别手抄字面量（会和 `tauri.conf.json` 漂移）。
- 「上次运行的版本」记在 `app_data_dir/install-state.json`，**在用户点掉提示时写**（`ack_startup_notice`），所以同一版本只提示一次；升级是否再提示**只看上次的版本是不是 2.1.0**，从 2.1.1 及以后升上来一律沉默。install-state.json 比 2.1.0 晚出现，所以现实中「装过 2.1.0」的证据就是**目录在、记录不在**（`ran_before()` 且读不到版本）。写失败只记日志，不能让提示卡在那里。
- `StartupNotice { kind, previous_version }` 的 `kind`（kebab-case）是前后端契约，`src/lib/types.ts` 的联合类型按字面量认它，`install.rs` 里有测试钉住；新增第三种之前先想清楚前端怎么显示。
- 弹窗里那个重置按钮复用 `resetPinnedEndpoints`，不要再写一条清理路径；文案必须写明「会清掉当前正在运行的程序」，否则用户会以为它只清旧版本留下的东西。
- **开发期测试入口**：debug 构建读环境变量 `AAR_STARTUP_NOTICE`（取值 `first-run` / `upgrade`），强制本次启动提示的种类——ack 过一次的机器否则永远见不到向导（状态文件正在尽职）。release 构建不读这个变量；强制提示被点掉时照常写 `install-state.json`。

---

## 主题系统

- 使用 CSS variables 定义色板
- `darkMode: 'class'` 策略
- 主题切换通过 `document.documentElement.classList.toggle('dark')`
- 持久化用户偏好到 `localStorage` + 跟随系统初始值
- 色板为青色（cyan）信号色，不用靛紫/紫罗兰；改色时 `:root` / `.dark` 两份定义与 `--*-rgb` 镜像通道必须一起改（`--bg-primary` / `--text-primary` 还在 `index.html` 里各有一份首帧内联副本，也要同步）
- **这套界面是平的**（2026-10-05 起）：所有面板都是**实底 + 1px 细线**，没有 blur、没有渐变、没有辉光。
  分层全靠三样东西：`--hairline`（贴着底色的分隔）、`--hairline-strong`（浮起面板的描边）、`--shadow-float`
  （全项目唯一允许的阴影：一层接触影 + 一层环境影，只给真正浮在页面之上的东西——Toast、现状气泡、弹窗、看板上的卡片）。
  与页面齐平的面板（左栏的行、设置页的纸）**没有阴影**——分隔是细线的职责。
  实底面板这个语义只留给正在生效的东西。曾经的那套液态玻璃（`--glass*` 令牌、`.glass*` 类、`.aurora`、`.grain`、
  `useGlassSpecular` 指针高光、glass-lite 低配档）已于今天整体退役，**别再搬回来**：
  它最吃执行，差一点就从「透镜」滑向「塑料贴纸」，而 `backdrop-filter` 的重采样成本还永远挂在 GPU 上。
- **角色四色**（`--type-*`）只属于看板：`primary`（主输出）/ `mirror`（副本）/ `idle`（没参与）/ `feed`（**送入程序的输入**，琥珀）。
  **同一个颜色画两处**（卡上的角色词与它的编号角标），所以它们没有 `-hover` 之类的变体，也不许拿去给别的东西上色。
  **没有"已选未应用"那一色**：那个区别由 hub 卡自己承担——待生效时它是一枚带「点按生效」胶囊的按钮，已经是事实时它退回一块普通面板。
  ⚠️ 四色的 `-rgb` 镜像通道要一起改（`bg-type-feed/xx` 这类透明修饰符靠它）。
- **圆角是阶梯，不是随手取的数**（`tailwind.config.ts` 的 `borderRadius`）：`window 28 → panel 24 → card 20 → ctl 12 → seg 10`。
  2.3.0 放大过一档（20/18/14）；2026-10-06 启动向导定稿时又上移一档（28/24/20/12/10），并确立了读法：
  **大圆角长在形状本身上，不是给内容套卡片框**——要"大的圆的平面"，不要"描边的盒子"。
  层级务必取自这一串值（容器大、控件小），别在调用点写 `rounded-[13px]`。
  阶梯只管**停着的矩形平面**（设置页的纸、弹窗、看板上的卡片）。**浮起来的小控件是胶囊或真圆**：toast、rail 的选中与搜索、「直说」按钮一律 `rounded-full`；
  现状气泡与看板卡片的浮层是**多行面板**，走 card 级圆角（`rounded-card`）。
  同心圆家族（`Ring`）是**真圆**——一律 `rounded-full`，任何超椭圆/圆角方块的形状都会把"同心圆"读成"方块摆成圈"。
- **连续曲率圆角**（2026-10-05 起）：`.cc` 这个类在支持 `corner-shape` 的渲染器上把矩形平面切成**连续曲率角**（squircle），
  于是高光不在角上打结。写在 `@supports (corner-shape: supercircle(2))` 里，是**纯渐进增强**——
  渲染器不认识就当它不存在，大半径自己站着。**别把它用到真圆上**（真圆没有角可以连续），也别为它加分支逻辑。
- `.con-ring*` 是同心圆指示器的一族：外环（描边）说"它是什么"，`::after` 的内芯说"它在不正在响"，中间那一圈什么都不画是必须的——
  没有那圈空就读不出同心，变成一个点加一块糊掉的东西。`-live::before` 那圈扩散同样是**有信息**的循环，因此与看板上的线一样必须走 `useLiveness` 闸门。
- `.nwire` 是看板上的线：**一根灰线**（`--text-muted`，1.75px，半透明），悬停点亮时加深加粗；
  `.pin` 是卡片两端的引脚短桩，`.no` 是编号角标。**线的颜色不许跟着角色走**——角色色只长在角标与角色词上（见「节点看板」）。

```css
:root {
  --bg-primary: #eef0f3;      /* 窗口那层底：所有面板浮在它上面 */
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

  /* 全项目唯一允许的阴影：只给真正浮在页面之上的东西
     （Toast、现状气泡、弹窗、看板卡片）；与页面齐平的面板没有阴影。 */
  --shadow-float: 0 1px 2px rgba(24, 40, 66, 0.06), 0 8px 24px rgba(24, 40, 66, 0.1);

  /* 看板上的四种角色（只有这四种）。 */
  --type-primary: #0891b2;
  --type-mirror: #0f766e;     /* 与 primary 邻近的色相，不是第二个 accent */
  --type-idle: #94a3b8;
  --type-feed: #b45309;       /* 程序的输入：送入 */

  --accent-rgb: 8 145 178;
  --error-rgb: 239 68 68;
  --bg-tertiary-rgb: 232 232 236;
  --text-muted-rgb: 113 113 122;
  --hairline-rgb: 230 230 234;
  --surface-rgb: 255 255 255;
  --type-primary-rgb: 8 145 178;
  --type-mirror-rgb: 15 118 110;
  --type-idle-rgb: 148 163 184;
  --type-feed-rgb: 180 83 9;
}
.dark {
  --bg-primary: #0b0e14;
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

  /* 同一枚影子，加深：近黑底上靠环境影托起浮层。 */
  --shadow-float: 0 1px 2px rgba(0, 0, 0, 0.45), 0 8px 24px rgba(0, 0, 0, 0.35);

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
  --type-feed-rgb: 251 191 36;
}
```

---

## 节点看板 UI 规范（2026-10-05 改版，改动前必读）

路由页是一张**节点看板**：**左中是当前程序**（hub 卡），**右侧一列是它的去向**（`Target`：输出设备，或**另一个程序的输入**），
hub 的**出脚**到去向的**入脚**之间那根线**就是**路由的这一段。这一屏回答的是「**这个程序的声音正往哪儿去**」——
线连着谁，声音就去哪儿，眼睛不必先读完一行列头。

视觉语言是**实底面板 + 1px 细线 + 同心圆**（`Ring`；令牌与阴影见「主题系统」），
外加一件新东西：**编号角标**（`.no`，01/02/03…）。**编号就是路由顺序**——
01 永远是主输出（由 Windows 直接播放的那台），之后是副本，再之后是送入的程序输入。颜色长在角标与角色词上，
**不在线上**：这是这一版从达芬奇调色页借来的那一条，也是它不乱的原因。

### 为什么是这个形状

历次改版各有各的复活风险，逐条写明，别把删过的东西再拿回来：

| 版本 | 内容 | 现状 |
|------|------|------|
| ① 液态玻璃 + 同心圆舞台 + 胶囊节点 | `ConcentricRouter` / `DeviceAnnotation` / `OutputStatusBar` / `useFitScale` / `useDecorativeMotion` | 已删 |
| ② 路由树 | `RouteFlow` / `RouteSubject` | 已删，不要复活：同一批设备讲两遍，两遍的排序依据还不同 |
| ③ 扁平编辑器式 + 设备表格 | `DeviceTable` | 已删：表格说得出路由由什么组成，说不出「流向」 |
| ④ 节点画布（自由布局） | `RouteCanvas` / `EdgeLayer` / `SourceNode` / `DeviceNode` / `RouteConfirmCapsule` / `lib/canvas.ts` / `--canvas-grid*` | 已删，**不要以"自由画布"的形式复活**：可拖摆的画布 = 可以被摆乱，还要平移缩放、ResizeObserver 与"动画期间钉住被测那一帧" |
| ⑤ 同心圆舞台（圆环 + 圆盘 + 辐条） | `ConcentricStage.tsx` | **2.3.0 已删**：一个程序的去向只有一列时环形毫无用处，而"程序 → 程序"进来之后路由不再是一颗星，环形撑不住 |
| ⑥ 节点看板（当前） | `NodeStage.tsx` + `lib/stage.ts` | 是**固定布局**的节点图：位置由路由顺序算出来，没有拖动、没有平移缩放、没有画布管理——节点是系统的（程序、设备、程序输入都是枚举出来的），用户永远不需要"创建"任何东西 |

⑥ 保留下来的旧资产：**`Ring` 同心圆**（卡片上的状态标记）、**点按生效**（计划/事实两段式）、
**调音条**（角色决定有哪些杠杆）、**流动虚线**（正在出声）。⑥ 新增的词汇只有两个：**编号**（顺序）与**琥珀色**（程序输入）。

### 计划与事实（`drawn` / `live`）

- `drawn = selectedDeviceIds` 是**计划**，`live = routedPids[pid]` 是**事实**。选中一个程序时，store 用事实（无路由时用系统默认设备）预填计划，
  所以刚选中时屏幕上出现的是现实；动过手之后出现的是待办的改动。
- ⚠️ **看板画的顺序是落地时采用的顺序**（`orderByDelay`，稳定排序），不是 `selectedDeviceIds` 的原始顺序：没配延迟时两者一致，
  配了延迟时角色词当场落在真正会坐主位的那台上——预览不许说谎。hub 的 `aria-label`（`stage.applyAria*`）与 `alreadyApplied`
  （`lib/stage.ts`，有单测）读的是同一份顺序。
- ⚠️ **hub 不许自称计划是事实**：待生效时它是一枚按钮（带「点按生效」胶囊与 accent 描边），
  已经是事实时它 `disabled`、退回一块普通面板——"你正在看着答案，不该再问你一遍"。
  程序自己的摘要（从哪几台出声、送入几个）常驻在底部**调音条**里，与它是不是按钮无关。

### 看板几何（`lib/stage.ts`）

`BOARD_W(640)` / `BOARD_H(470)` / `HUB_W(190)` / `HUB_H(84)` / `HUB_X(196)` / `TARGET_W(190)` / `TARGET_H(62)` /
`TARGET_X(436)` / `MINI_W(140)` / `FEEDER_X(16)` / `PIN_D(11)` 是**唯一的**尺寸来源，由 `targetY()`、`feederY()`、
`hubOutPort()`、`hubInPort()`、`targetInPort()`、`feederOutPort()`、`nodePath()` 算出位置与线两端。
组件用 `style` 从这些常量取宽高与坐标，**不要**改成 Tailwind 的 `w-[…]`：尺寸在两处各写一份，线迟早会离开卡片。

⚠️ **尺寸有预算，且只增不压**：`BOARD_H` 是应用在 900px 默认窗口下工作区的实测尺寸。
去向多于三张时**板子长高、井滚动**（`boardHeight(count)`），**绝不把卡片挤到一起**——两张卡叠住等于其中一条去向看不见，
比滚动条糟得多（这条有单测钉着）。

同一条理由决定了这里**没有拖动、没有平移、没有缩放**：位置由路由顺序决定 → 几何是算术 → 不需要 ResizeObserver，
也不需要在每次布局后重算端点；`getBoundingClientRect` 在这里会让每根线比每段弹簧晚一帧。

### 三类卡（hub / 去向 / 来源）

- **hub**：当前程序。名字、图标、`Ring`（有计划时 main）、状态词（正在播放/未在播放）、`stage.feedCount`（送入几个）。
  待生效时它是按钮（点它 = `applyRoute`），已生效时 `disabled`。多设备路由时电平环挂在它下面（`drawn.length > 1`）。
- **去向卡（右侧一列）**：设备卡的角标编号即顺序，名字按钮**点按 = 进出这条路由**（`toggleTarget`，最后一个设备不可移除——
  "路由不可能被点空"的守卫在这里，不在 store）。副本的角色词就是**换主位的开关**：平时写「副本」，悬停/聚焦变「设为主输出」，
  `aria-label` 是 `stage.promote`（读屏听到的是动作）。延迟补偿严格更大的副本没有这个开关，`title` 解释原因。
  送入卡（琥珀）写「送入 / 挂起 / 未接通」三态之一，✕ 立刻断开（走 Toast 撤销，不是计划）。
- **来源卡（左侧一列）**：谁把声音送进了当前程序。点它**切到那个程序的看板**——图一次讲一个程序，这是两个程序之间的门。

### 编号与调音条（`Inspector`）

- **角标即调音入口**：点去向卡的编号，底部调音条切到那张卡的杠杆——主输出=会话音量一行，副本=延迟 + 份额两行。
  ⚠️ **单设备路由没有编号按钮**（那是 `span`，不是按钮）：一个设备的路由由系统直放，没有引擎，也就没有可调的杠杆——
  与旧舞台同一条规则。`drawn.length > 1` 是唯一条件，别为单设备路由特例盖章。
- 调音条默认显示 hub 的摘要；选中另一个程序时清空（键里的设备 id 不许跨程序存活）。
- **± 按钮的 aria-label 沿用旧词表**（`deviceDelay.stepUp/stepDown`、`deviceVolume.*`、`primaryVolume.*`），
  值里的单位也跟着角色走（延迟带 `ms`，音量带 `%`）。
- ⚠️ **实测延迟仍然只在 tooltip 里**（`deviceLatency.reading`）：它是读数不是控件，主输出那条没有它（没有属于我们的流）。

### 送入（feed）：2.3.0 的新路由形态

- 送入**不是计划**：它两端各钉一个端点（源 → 载体的播放侧，目标 ← 载体的录音侧），所以**选中即生效**，
  撤销由 Toast 提供（`feedUndo`）；这一点与设备路由的两段式不同，是有意的——两端都被钉住的关系没有"预览"可言。
- 三态由 `feedLiveness()` 判定，卡上照实写：
  **`live`（送入）= 载体已配且源没被设备路由占着渲染槽**；
  **`suspended`（挂起）= 源正输出到设备**——每应用只有一个渲染槽，被路由占了，停掉那条路由后送入自动恢复（`stop_route` 里就地把载体钉回去）；
  **`no-carrier`（未接通）= 设置页还没选端点对**，规则照记，声音不动。
- ⚠️ **渲染与捕获是两个数据流**：`PinnedRoutes` 里分成两本账（`mark_feed` / `mark_feed_capture`），
  释放也分（`release_process_default_devices_flow(…, capture)`）。停止一条设备路由**不能**顺手清掉捕获侧——
  那个程序还可能在收别人的声音。只有"重置每应用音频输出"与退出这两条路会两个流一起清。
- ⚠️ **别把送入并进设备路由的记忆**：`feed-memory.json` 与 `route-memory.json` 是两份，
  一条规则的存在不依赖另一条；恢复也各自独立（`restoreRememberedFeeds` vs `restoreRememberedRoutes`，都由列表/记忆/载体的到达触发）。
- **设置页会点名探测常见回环驱动**（`lib/carrierDetect.ts`：VB-Cable、VoiceMeeter；按友好名的子串匹配、
  不区分大小写，VoiceMeeter 的标记故意不命中 Aux 对——「… Aux Input」截断了子串，Banana/Potato 系统配的是 VAIO 对）。
  检测到就给「一键配对」（走现成的 `setFeedCarrier`）；没检测到**且载体未配置**时给 VB-Cable 下载指引——
  `open_carrier_download` 的 URL 映射固定在 Rust 侧（`commands.rs` 的 `CARRIER_PAGES`），前端只传驱动 key、永不传 URL，
  页面经 `ShellExecuteW` 的 open 动词交给浏览器关联。探测只是认名字，**不是携带**：应用仍然不自带、不安装任何驱动；
  已配置载体但不是已知驱动时保持安静（用户自己配的，别念叨）。
- 两份设备列表都随 `audio-changed` 刷新（`syncFromNotification` 的 devices 分支也拉捕获列表），
  所以「装完回环驱动 → 不重启 → 一键配对」这条链是闭环的，别把捕获列表从那条路里摘出去。

### 布局与其余规矩

- `App` 根节点 `relative isolate`，背景就是 `--bg-primary` 那层纯色平面，**标题栏透明**。
  下面是 `aside`（236px + `border-r border-line`）＋ `main`（`relative`，给现状气泡一个锚点）＋ `UnderlineTabs`（Routing / Activity）。
- **路由只由看板表达**：线就是路由。**别在别处再画第二份**（树、状态条、常驻的文字摘要）；
  现状气泡是**按需的例外**（见下节），不常驻。左栏第二行说"这个程序从哪台设备出声"是列表的本分，不算第二份路由图。
- **accent 只用来标记"属于路由的那部分"**：左栏的选中行、hub 待生效的描边与胶囊。角色词按角色上色（那是编码本身）。
- 数字与标识符（PID、毫秒、百分比、版本号、exe 名、角标编号）用 `font-mono tabular-nums`。
- **误操作防护**：① 看板只是提案，改动要按 hub 才落地（送入例外，见上）；② "也改这个"有看得见的开关；
  ③ 破坏性且影响全局的动作用 `ConfirmButton`；④ 路由与送入后 Toast 各给 8 秒撤销。路由不可能被点成空的（最后一个设备卡不可移除）。
- **i18n**：文案分组是 `rail` / `stage` / `briefing` / `settings` / `toast` / `log`，
  两组 locale 的键集合、占位符与非空由 `src/i18n/locales.test.ts` 的对称测试保护。
  句子说人话，避开"路由 / 镜像 / 主设备"这类内部词。
- **禁止**：胶囊状的**标签页**（标签仍是下划线，`layoutId` 迁移）、常驻装饰循环
  （背景漂移、轨道环；**线流动与脉冲环是唯二的例外，且必须走卸载式闸门**）、看板的拖动·平移·缩放、自由摆放的节点、
  第二份路由摘要、把延迟/音量画到主输出上（包括"变淡地画"）、给同心圆家族加任何非正圆的形状。
- **动效**：全部取自 `lib/motion.ts`——`SPRING_TAP`（卡片按压、行内的微交互）/ `FADE`（纯透明度入场）/
  `SPRING_GLIDE`（有位移的视图切换），**不要在调用点现调参数**：邻居之间弹得不一样看着像 bug，不像设计。

### 现状气泡（`StatusBriefing`）

工作区左下角的「直说」小胶囊，点一下弹出一个实底气泡，用大白话说清**此刻**的播放情况——只报告，不操作。
⚠️ **它的锚点抬到了调音条之上**（`bottom-[56px]`）：看板的调音条占着底部那条带，浮在它上面的按钮会吃掉左侧控件的点击
（这个 bug 由 e2e 抓出过一次）。
- 内容一行一程序（`briefing.routeOne` / `routeMulti`，设备名列表用 `Intl.ListFormat` 按当前语言连接），送入另起一行
  （`briefing.feedLine` / `feedHeldLine`：路由占着渲染槽时送入是**挂起**的，句子要说出来）；没有任何改道时说"都跟着系统默认设备走"。
- ⚠️ **它是「路由摘要」禁令的按需例外**：常驻的第二份路由表达仍然禁止。
- ⚠️ **`Escape` 与 `pointerdown` 的监听跟着气泡的可见性注册与注销**：常驻注册会把整个窗口的 Escape 全吞掉。

### 左栏（`ProgramRail`）

每行：一枚 `Ring` + 程序名 + 第二行 `PID xxx`（只有已路由的行才追加 `· 设备名 +n`）。
行末那颗圆形小开关（`MiniToggle`）"同时更改此程序的输出"取代了 Ctrl+点击；排序为"已路由在前、组内稳定"。
搜索、✕ 停止（`ConfirmButton`）、表头"全部默认"都保持原样。
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
- [ ] 显示名：有窗口的程序在左栏首行、hub 卡（及其按钮的 `aria-label`）显示**可见**窗口标题（浏览器换标签跟着换名且不写「进程列表变化」日志）；托盘常驻或 UI 在别的进程里的程序显示版本资源描述（steam.exe → "Steam"，不是隐藏窗口的「无标题」；msedge.exe → "Microsoft Edge"，不是被砍半的 "Microso"），两者都没有时回退 exe 名；左栏第二行在两者不同时保留 exe；搜索两个名字都命中
- [ ] 图标：左栏每行与中心显示 exe 图标（同 exe 的多个进程只有一份，也只发一次询问）；像素异步到达时行不移位（占位槽尺寸固定）；问的瞬间 pid 死掉或提取一时失败，后续刷新自动补问、图标自己回来；真正无图标的程序稳定显示首字母，不报错
- [ ] 设备列表正确显示渲染设备
- [ ] 路由操作成功（进程音频切换到目标设备）
- [ ] 停止路由后程序跟随系统默认设备：之后手动切换默认输出，它也一起走（2.1.1 的回归点）
- [ ] 路由期间直接退出应用：程序不再被固定在旧设备上
- [ ] 设置 →「重置每应用音频输出」能清掉旧版本留下的固定记录，且不动正在路由的进程
- [ ] 启动提示：装过 2.1.0 的机器第一次打开弹「检测到曾安装过旧版本」且能就地重置；全新安装进全屏向导（四步走完或跳过都算点掉）；点掉后同一版本不再弹（版本记在 `install-state.json`）；从 2.1.1 及以后升上来的机器**不再弹**——只有 2.1.0 会留下固定端点
- [ ] 启动向导：全新安装第一次打开是全屏四步向导（标题栏与窗口控制可用、设置入口隐藏）；载体一步点名检测到的回环驱动并可一键配对，没装时给 VB-Cable 下载指引；后台一步的两个开关真实落到注册表与 `app-settings.json`；完成/跳过/`Escape` 都 ack，同一版本不再出现；向导期间看板与左栏不渲染、退出向导后它们照常出现。**向导没有容器面板**——内容直接坐在工作区上（与设置页同款），
任何"包住整步的圆角面"不管有没有描边都是卡片，都是被否掉的形状；大圆角只长在真实的形状上（载体行、示意图卡取 `rounded-card`），
步进点是同心圆 `Ring`（当前步内芯点亮），切步时标题与正文**逐字由模糊到清晰**进场——一次性入场、不循环，控制件（行/开关/按钮）整块进场不做逐字
- [ ] 选中一个进程后点击另一台设备：只输出到那一台，不再两台一起响
- [ ] 自动记忆：开启后路由一个程序，重启本应用或让该程序重新出声，路由自动恢复且日志各留一行；手动停止过的不会被装回去；设置页能列出并「忘记」某条记忆
- [ ] 插上一个新设备 / 让一个新程序开始放音：不点 Refresh，两边列表自己跟上，且日志只在内容真的变化时多一行
- [ ] 托盘图标常驻，左键开关窗口；开启「关闭窗口时最小化到托盘」后按 X 不退出、路由继续
- [ ] 开启「开机自动启动」后：注册表 `HKCU\...\Run` 有那一条、重启后只出现托盘图标不弹窗、开关状态仍与注册表一致
- [ ] 单实例：程序已经在运行时再次启动它，只把已有窗口唤到前台，不出现第二个托盘图标，也不重复起一份复制引擎
- [ ] 进程列表搜索：输入即时过滤，已路由的排在最前且组内顺序稳定；`Escape` 清空并失焦；无匹配时的提示与「没有进程在放音」不是同一句
- [ ] 节点看板：选中一个程序后它是 hub 卡（名字写在卡里），右侧一列是它的去向（输出设备在前、送入的程序在后）；每张卡有编号角标（01 起，**编号即路由顺序**），hub 出脚到去向入脚之间一根灰线——**没参与的设备不在板上、也没有线**；「＋ 添加去向」的虚线卡是加入的入口（选择器里设备与程序输入分两组）
- [ ] 送入程序：选中 A，经虚线卡把 B 的输入加进来——卡上写「送入」并立刻生效（`set_feed_target`，没有 hub 那一步），Toast 给撤销；把 A 路由到设备后这张卡改口写「挂起」（渲染槽被占），停掉设备路由后自动恢复；设置页没配载体时写「未接通」且日志点名原因；设置页选好回环端点对后挂起/未接通的送入自己接通
- [ ] 送入载体的检测与引导：装了 VB-Cable/VoiceMeeter 的机器，设置页点名检测且「一键配对」把端点对写进载体（看板上的送入卡随之从「未接通」变「送入」）；没装且载体未配置时给出 VB-Cable 下载指引，点击打开官方页（`ShellExecuteW`）；**已配置载体时不出指引**；装完驱动不重启应用，设备列表自动跟上、即可配对
- [ ] 先替换、后追加：选中一个已路由的程序后**第一次**加入另一台设备是替换（只输出到那一台），同一状态下再加别的才是追加成副本；路由里只剩一台时点它被忽略、它的 ✕ 也不出现——**路由不可能被点成空的**
- [ ] 换主输出：多设备计划中副本的角色词带点状下划线，悬停/聚焦由「副本」变「设为主输出」，点击后两张卡的角色词当场对调、按下 hub 后后端收到以它为首的设备顺序；延迟补偿更大的副本悬停不出现动作且 `title` 说明原因；给副本调一个比主输出更小的延迟（可为负），主位当场换人——卡片角色词、hub `aria-label`、落地顺序三处一致
- [ ] hub 卡即应用：有改动待生效时它是一枚按钮（卡上挂「点按生效」胶囊与 accent 描边，`aria-label` 是完整句子、列出全部去向），按下即落地并给 Toast 撤销；画面已经是事实时它不可按（胶囊消失、`disabled`），程序摘要改由底部调音条承担；未选中程序时板上是一句引导；丢弃已选改动 = 重新选中那个程序（计划被事实读回，不发任何 apply_route）
- [ ] 现状气泡：左下角「直说」点开，用大白话说清此刻的播放情况——没改道时说清都跟着系统默认设备走、每个已路由程序一行点名设备、没出声的缀一句；有没落地的改动时补一行怎么让它生效；再点一次 / 点气泡外面 / `Escape` 都能关掉
- [ ] 批次：左栏行末那颗圆形开关能把另一个程序并进这次改动（不知道 Ctrl 也能做）；Ctrl+点击名称做同一件事，两处的状态一致
- [ ] 声流：只有画出来的路线与正在生效的完全一致、且程序在响时，线才跑流动虚线；程序一停虚线消失（卸载，不是暂停）；把窗口切到后台或失焦，**线与脉冲环都被卸载**，静止界面不产生任何重绘；系统「减少动态效果」开启时同样静止
- [ ] 调音条按角色出现：路由 ≥2 台时，点**副本**卡的编号看到延迟+份额两行（延迟走设置页步进并在 ±range 禁用对应方向，份额 0–100 固定步进 5%）；点**主输出**卡的编号只有音量一行（会话音量，5–100、步进 5%，到 5 禁用减号），没有延迟行——`title` 解释原因；**单设备路由的编号不是按钮**，调音条也不给设备面板；改了立刻生效
- [ ] 主输出音量：多设备路由下步进主设备的音量，后端收到 `set_primary_volume`（exe + percent）且副本的份额与日志不动；**停止路由后程序的会话音量回到路由前的值**（音量混音器可验证）；应用退出同样归还；被 Windows 混音器在路由期间改掉会话音量属于已知未监听的漂移，触一次本应用的滑杆即重新对齐
- [ ] 电平环：路由 ≥2 台设备的程序，hub 卡底下带环（拖动/滚轮/键入可改，环随手势走）；单设备路由与未路由的程序没有环；100 时该 exe 不落盘（`source-volumes.json` 里查不到）
- [ ] 标题栏计数：有路由时显示「已路由 n · 播放中 m」，m 只数被路由且在响的程序；清空所有路由后计数整条消失
- [ ] 镜像设备失败：让一台正在镜像的设备打不开，该设备从路由徽标里消失并留一行点名它的 error 日志，其余设备继续出声
- [ ] 功耗：路由一个程序到 2–3 台设备后让它静默，`powercfg /energy` 里本进程的唤醒数从约 100×设备数/秒降到个位数；音频恢复时无爆音，停顿后第一声的延迟与连续播放一致
- [ ] 延迟/音量的「能不能调」由结构说明：单设备路由**没有**这些控件（编号不是按钮），副本上才有；改了立刻生效
- [ ] 实测延迟读数：路由一个程序到 2–3 台设备，副本那组延迟行的 tooltip 显示软件侧延迟且**随延迟补偿变化**；主设备那一格不存在（它没有那组控件）；停掉路由后读数**立刻消失**，不留旧数字
- [ ] 每源电平：路由两个程序到同一组设备，把其中一个调到 <100 或 >100，只有它的响度变（环在 hub 卡底下调节；设置页只剩一键对齐）
- [ ] 一键对齐：两个程序同时放音，点「对齐电平」后两条响度接近，且**没在放音的程序原样不动并在日志里被点名**；只有一个程序在放音时提示说的是「只有一个」而不是「没有在放音」；主输出音量不同的两个程序对齐后，副本路径可能仍有差别（对齐以主输出路径为准）
- [ ] 撤销：改路由后撤销回到上一步；撤销一个原本未路由的进程 = 回到未路由；开了自动记忆时，**撤销之后重启该程序不会把撤掉的路由装回来**；手动停掉某条路由后 Toast 不再提供撤销
- [ ] 误操作防护：左栏表头与每个已路由行里的「回到系统默认」都需二次确认（Escape / 失焦 / 超时解除）；Toast 退场时不吃掉紧接着的点击
- [ ] `Escape` 不被任何常驻监听吞掉——**搜索框里的 `Escape` 仍然能清空搜索**（现状气泡与 Toast 的监听都跟着可见性注册与注销）
- [ ] Light/Dark 切换流畅（两个主题都是实底面板 + 细线，切换不闪帧）
- [ ] 切页与下划线迁移流畅（60fps）；界面静止时（无程序在响、或窗口隐藏/失焦）不产生任何常驻重绘——线流动与脉冲环是唯二的主循环，且静止时被卸载
- [ ] 去向很多时：给一个程序加到 6 台设备，看板长高、井里滚动，**卡片之间不重叠**（`boardHeight` 的规矩）
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
