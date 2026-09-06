# App Audio Router

## 简介

App Audio Router 是一个 Windows 上的「每应用音频路由」工具，允许用户将特定程序的音频输出路由到指定的音频设备。基于 Tauri v2 构建，前端使用 React 19 + TypeScript + TailwindCSS，后端由 Rust 直接调用 Windows Core Audio API 实现全部音频操作，**无任何第三方 exe 依赖**。

## 功能特性

- 枚举有音频会话的进程
- 枚举音频渲染设备
- 将指定进程的音频输出路由到指定设备
- 自动记忆路由规则，重启后保留
- 同心圆交互 UI，路由操作带涟漪动画
- Light / Dark 主题切换

## 系统要求

- Windows 10/11
- 从源码构建：Node.js LTS、pnpm、Rust stable

## 开发与构建

```bash
# 安装依赖
pnpm install

# 开发模式（热重载）
pnpm tauri dev

# 构建（产出 MSI 安装包）
pnpm tauri build
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 |
| 前端 | React 19 + TypeScript (strict) |
| 样式 | TailwindCSS v4 |
| 动画 | Motion (`framer-motion`) |
| 构建 | Vite v6 |
| 后端 | Rust（`windows` crate，官方 Core Audio API 绑定） |

## 工作原理

1. Rust 后端通过 `IMMDeviceEnumerator` 枚举渲染设备
2. 通过 `IAudioSessionEnumerator` 枚举当前有音频会话的进程
3. 通过 `IPolicyConfig` 将进程会话路由到目标设备
4. 路由规则（进程可执行名 → 设备 ID 映射）由 Rust 端持久化到应用数据目录

## 项目结构

```
AppAudioRouter/
├── src/            # React 前端
│   ├── components/ # 同心圆路由、进程列表、设备列表、日志面板等
│   ├── hooks/      # 设备/进程轮询、主题等自定义 hooks
│   ├── stores/     # 前端状态管理
│   └── lib/        # Tauri invoke 封装与共享类型
└── src-tauri/      # Rust 后端
    └── src/
        ├── commands.rs    # Tauri 命令
        ├── config.rs      # 配置持久化
        └── audio/         # 设备枚举、会话枚举、路由设置
```

## 注意事项

- 需要目标程序正在运行并发出声音，才会出现在进程列表中
- 自动记忆功能基于进程可执行文件名，而非 PID
- 不支持对系统关键进程进行音频路由
