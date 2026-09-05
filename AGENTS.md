# AGENTS.md — App Audio Router

> 协作规范。所有贡献者（含 AI agent）必须遵守。

---

## 项目概述

Windows 平台「每应用音频路由」工具。Tauri v2 + React + TypeScript + TailwindCSS + Motion。

核心能力：枚举有音频会话的进程、枚举渲染设备、将进程路由到指定设备、自动记忆路由规则。

**硬性约束：无任何第三方 exe 依赖。** 所有音频操作由 Rust 直接调用 Windows Core Audio API。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端 | React 19 + TypeScript (strict) |
| 样式 | TailwindCSS v4 (utility-first, CSS variables) |
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
│       │   ├── devices.rs  # IMMDeviceEnumerator 设备枚举
│       │   ├── sessions.rs # IAudioSessionEnumerator 会话枚举
│       │   └── routing.rs  # IPolicyConfig 路由设置
│       └── config.rs       # 配置持久化
├── src/                    # React 前端
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/         # UI 组件
│   │   ├── ConcentricRouter.tsx  # 同心圆路由核心组件
│   │   ├── ProcessList.tsx
│   │   ├── DeviceList.tsx
│   │   ├── LogPanel.tsx
│   │   └── ThemeToggle.tsx
│   ├── hooks/              # 自定义 hooks
│   │   ├── useDevices.ts
│   │   ├── useProcesses.ts
│   │   └── useTheme.ts
│   ├── stores/             # 状态管理
│   │   └── routerStore.ts
│   ├── lib/                # 工具函数
│   │   ├── invoke.ts       # Tauri invoke 封装
│   │   └── types.ts        # 共享类型定义
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
   - Hooks：`use` 前缀 (`useDevices.ts`)
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

- 前端使用轻量 store（Zustand 或 React Context + useReducer）
- 路由记忆配置由 Rust 端持久化（`tauri-plugin-store` 或本地 JSON）
- 设备列表、进程列表由前端 hook 管理，支持手动刷新 + 自动轮询

---

## 主题系统

- 使用 CSS variables 定义色板
- `darkMode: 'class'` 策略
- 主题切换通过 `document.documentElement.classList.toggle('dark')`
- 持久化用户偏好到 `localStorage` + 跟随系统初始值

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f5f7;
  --text-primary: #1a1a1a;
  --accent: #6366f1;
}
.dark {
  --bg-primary: #0a0a0f;
  --bg-secondary: #15151d;
  --text-primary: #f0f0f5;
  --accent: #818cf8;
}
```

---

## 同心圆 UI 规范

- 中心圆：当前选中进程，显示进程名 + 图标占位
- 中环：涟漪动画，路由操作时触发
- 外环：设备列表，每个设备为一个弧段/节点
- 激活状态：`scale(1.05)` + `box-shadow` 扩散
- 路由动画：spring stiffness=300, damping=20

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
