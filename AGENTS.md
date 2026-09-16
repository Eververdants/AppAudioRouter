# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。

---

## 项目概述

Windows 平台「每应用音频路由」工具。Tauri v2 + React + TypeScript + TailwindCSS + Motion。

核心能力：枚举有音频会话的进程、枚举渲染设备、将**一个或多个（Ctrl+多选）进程**路由到一台或多台设备（多设备时第一台为主设备，其余通过进程回环复制，支持同步启动与按设备延迟补偿以对齐蓝牙）、按进程设置会话音量上限（重启路由后自动恢复）、自动记忆路由规则。

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
│       ├── main.rs         # 入口，注册命令
│       ├── commands.rs     # Tauri 命令（invoke handler）
│       ├── audio/
│       │   ├── mod.rs
│       │   ├── devices.rs      # IMMDeviceEnumerator 设备枚举
│       │   ├── sessions.rs     # IAudioSessionEnumerator 会话枚举
│       │   ├── routing.rs      # IPolicyConfig 单设备路由设置
│       │   └── duplication.rs  # WASAPI 进程回环 → 多设备复制引擎
│       └── config.rs       # 配置持久化（route-memory.json: exe -> 设备列表；device-delays.json: 设备 -> 延迟补偿 ms + delay_range_ms 正负范围上限；session-volumes.json: exe -> 音量上限 %）
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── ConcentricRouter.tsx  # 同心圆路由核心组件（设备节点 + 每个选中设备旁的延迟气泡）
│   │   ├── ProcessList.tsx
│   │   ├── SettingsPage.tsx      # 设置独立页面（主题/语言/路由开关/延迟范围·步进·逐设备设置/关于）
│   │   ├── LogPanel.tsx
│   │   ├── TitleBar.tsx    # 自定义标题栏（无边框窗口，仅品牌 + 设置入口 + 窗口控制）
│   │   └── ui/             # 基础控件
│   │       ├── Switch.tsx              # 动画开关
│   │       ├── SegmentedControl.tsx    # 滑动胶囊分段控件
│   │       ├── StepButton.tsx          # 圆形 ± 按钮（延迟控件共用）
│   │       ├── DelayCapsule.tsx        # 设备节点旁的延迟小胶囊（−/数值/+）
│   │       └── DelayStepper.tsx        # 设置页的延迟行控件（同款逻辑、方框样式）
│   ├── hooks/              # 自定义 hooks
│   │   ├── useTheme.ts
│   │   ├── useLanguage.ts
│   │   ├── useDelayValue.ts  # 延迟编辑状态（草稿/提交/步进），两个延迟控件共用
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
- 延迟入口在**设备节点本身**：同心圆上每个选中设备的节点下方挂一个 `DelayCapsule`（−/数值/+，值可键入）；不要在舞台底部再做常驻面板。
  `delaySync` 关闭时胶囊变淡并提示「延迟同步已关闭」；设置页仍保留逐设备列表，便于给未选中的设备预设延迟。
- 音量上限按 exe 持久化到 `app_data_dir/session-volumes.json`（`config.rs`，exe -> %），通过 `ISimpleAudioVolume` 设置会话主音量，`apply_route` 时自动重放；100 表示不限制（不落盘）
- 复制引擎通过后端事件 `duplication-stopped`（pid / reason / error）向前端同步状态
- 设备列表、进程列表由 store action 管理，支持手动刷新（无自动轮询，避免后台 IPC）

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
  - 选中设备的节点**下方挂延迟小胶囊**（`DelayCapsule`）：− / 数值（可键入）/ +；延迟为 0 的设备默认隐藏气泡，悬停或聚焦该设备（节点带 `group/device`）才浮现，非 0 值常驻显示，避免一圈气泡把舞台塞满
  - 节点胶囊保持紧凑（`max-w-[116px] px-2.5 py-1`），不要回到宽松尺寸
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

---

## 安全注意事项

- 所有 Tauri 命令必须在 `tauri.conf.json` 的 `capabilities` 中声明
- 禁止在前端拼接 shell 命令
- Rust 端 COM 调用必须校验输入（device_id 格式、pid 范围）
- 配置文件写入路径限定在 `app_data_dir`，禁止写任意路径

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
- [ ] Light/Dark 切换流畅
- [ ] 同心圆动画流畅（60fps）
- [ ] `pnpm tauri build` 产物可安装运行
- [ ] 无第三方 exe 依赖
