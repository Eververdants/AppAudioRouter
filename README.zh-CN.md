<p align="center">
  <img src="src/assets/app-icon.png" width="96" alt="App Audio Router 图标：一段音频波形分裂成两个箭头">
</p>

# App Audio Router

**Windows 每应用音频路由工具：把某个程序的音频同时送到多台播放设备（每台都能单独设置延迟补偿与音量），也可以送进另一个程序的输入。**

<p align="center">
  <a href="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml"><img alt="CI 状态" src="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="版本 2.3.0" src="https://img.shields.io/badge/version-2.3.0-0891b2">
  <img alt="平台：Windows 10 与 Windows 11，64 位" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6">
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <img alt="技术栈：Tauri 2、Rust 与 React 19" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React%2019-24C8DB">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

Windows 本身只允许一个程序同时向一路输出播放声音，App Audio Router 解除了这个限制：选中一个程序、选中一台或多台播放设备，它的声音就会实时送到全部设备上——不需要重启该程序——也可以送进另一个程序的输入，让 Discord 像听见麦克风一样听见 Spotify。全部功能由单一原生程序直接调用 Windows Core Audio API 完成：没有辅助进程，路由也不装任何驱动（送入另一个程序走你自己安装并在设置里点名的一对回环端点）。

| | |
|---|---|
| **平台** | Windows 10 / Windows 11，64 位 |
| **当前版本** | 2.3.0 |
| **安装包** | 见 [Releases](https://github.com/Eververdants/AppAudioRouter/releases)，MSI 或 NSIS 安装程序 |
| **许可证** | MIT |
| **界面语言** | 简体中文、English |
| **外部依赖** | 路由无需任何依赖；送入走你自己安装并在设置里点名的一对回环端点 |
| **技术栈** | Tauri 2、Rust、React 19、TypeScript、TailwindCSS、Vite |

## 界面截图

![App Audio Router 的节点看板：Music.exe 的卡片连着右侧两块虚线面板里带编号的去向行（上块主设备、下块副本），底部调音条显示被点开的副本的延迟与份额，左边是程序列表](docs/images/app-audio-router-light.png)

![同一块节点看板在深色主题下的显示效果](docs/images/app-audio-router-dark.png)

整个应用就是这块看板：左边一条侧栏列出正在发声的程序，右边是带编号的去向行——01 由 Windows 自己直放，其余是本应用复制过去的副本，hub 的出脚到去向行入脚之间那根线**就是**路由。点某一行的编号，它的延迟与音量就在底部调音条里。

## 功能特性

- **一个应用 → 多台设备，即时生效。** 正在运行的程序被直接改到选中的设备上，不需要重启；第一台由 Windows 原生驱动，其余每台收到一路实时副本。
- **一个程序 → 另一个程序的输入（2.3.0）。** 同一张去向选择器里列出所有能收音的程序。它是**附加的一路**，不是搬走——程序自己照常出声——经你在设置里点名的回环端点对转接；没配之前规则照记，看板上如实说明。
- **逐设备延迟补偿。** 每台设备一个有符号毫秒值，把蓝牙耳机与有线音箱对齐。**设置 → 延迟补偿 → 校准**可以实测：设备轮流放短音，听到就点一下，差值自动写成补偿。
- **逐设备音量平衡。** 每路副本一个 0–100 % 的值，相对最响的那路衰减。Windows 直连的主设备走程序的会话音量，停止路由时归还原值。
- **逐程序电平对齐。** 每个被路由的程序有自己的 0–400 % 电平，一键把所有正在放音的程序对齐到最响那条。
- **自动记忆。** 路由规则按可执行文件名保存，该程序下次出声时自动恢复。
- **镜像失败会说清楚。** 路由里某台设备打不开时，其余设备继续出声，日志点名那台没声音的。
- **列表实时更新，从不轮询。** 设备与进程列表跟着 Core Audio 自己的变更通知走；没有任何定时器，安静的路由会停放而不是往设备里写静音。
- **不占地方。** 托盘菜单包办一切、可选关闭到托盘、可选开机自启（只写 `HKCU`，不需要管理员权限）、单实例、明暗双主题、中英双语——全部在一个窗口里。

## 与其它方案对比

| 能力 | **App Audio Router** | Windows 自带按应用输出 | 虚拟声卡混音方案（Voicemeeter / VB-CABLE 一类） | 按应用切换默认设备（EarTrumpet 一类） |
|---|---|---|---|---|
| 一个应用同时输出到多台设备 | **支持** | 不支持，一个应用只能选一路 | 支持，通过混音总线 | 不支持 |
| 对正在运行的程序即时生效 | **支持** | 支持 | 支持 | 支持 |
| 逐设备延迟对齐（蓝牙同步） | **支持**，每台设备一个有符号毫秒值 | 不支持 | 需手动逐总线设置 | 不支持 |
| 逐设备响度平衡 | **支持**，每台设备 0–100 % | 不支持 | 支持，用总线增益 | 不支持 |
| 送进另一个程序的输入 | **支持**（2.3.0，经回环端点对） | 不支持 | 不支持 | 支持（虚拟通道） |
| 是否需要虚拟声卡驱动 | 路由**不需要**；送入用一对**你自己装的**回环端点 | — | 需要 | — |
| 按程序记住路由 | **支持**，自动记忆 | 支持（两者本质是同一个 Windows 设置） | 在 Windows 里配置 | 继承 Windows 的按应用设置 |
| 费用 | **免费，MIT 开源** | 随 Windows 提供 | 免费或自愿付费 | 免费，MIT 开源 |

*其它几列描述的是这些方案公开文档中的一般行为，具体功能请以各自的官方文档为准。*

## 安装

1. 打开 [Releases](https://github.com/Eververdants/AppAudioRouter/releases) 页面。
2. 从最新版本下载 `.msi` 安装包（或 NSIS `.exe` 安装程序）。
3. 安装后启动 **App Audio Router**。

## 快速上手

1. **先在要路由的程序里放点声音。** 程序只有拥有活动音频会话时才会出现在列表里。
2. **在侧栏里选中它**——行末那个圆形小开关可以把另一个程序一起并进这次改动。
3. **加上它该从哪些设备出来。** 打头的那台由 Windows 自己播，之后每加一台就多一份各带延迟与音量的副本。
4. **点一下那张程序卡。** 路由落地，程序发声时连向去向的线开始流动。
5. **需要就调某一台**——点它的编号，延迟与音量就在底部调音条上。也可以改送另一个程序的输入：同一张选择器里选一个，选中即接通，撤销在提示条里。

## 系统要求

- **Windows 10 或 Windows 11，64 位。**
- WebView2 运行时——Windows 11 自带，装有 Microsoft Edge 的 Windows 10 也基本都有。
- 安装版就只需要这些：不用装声卡驱动、不用装服务、没有第三方可执行文件。

## 几件须知

- 记忆的路由按可执行文件名匹配，不区分完整路径，也不记录 PID。
- 延迟补偿只能**增加**延迟，组内最早的那台是基准；镜像副本自带约 100 ms 管线延迟，送入比源程序自己的输出晚约 100–140 ms。
- 程序被路由期间，Windows 会为它存下一台固定的输出设备（移动运行中程序的声音靠的就是这个机制）。停止路由、退出应用、以及**设置 → 重置每应用音频输出**都会把它交还——由于 Windows 的这条记录没有作者，重置同样会放开你在音量合成器里手设的那些。
- 系统关键进程的路由请求会被拒绝，而不是半途应用。
- 更新后第一次打开会先走一遍简短的全屏向导——升级会先问是否继承以前版本的设置——确认过一次就不再出现。

## 从源码构建

```bash
git clone https://github.com/Eververdants/AppAudioRouter.git
cd AppAudioRouter
pnpm install

pnpm tauri dev        # 开发模式（热重载）
pnpm tauri build      # 安装包输出在 src-tauri/target/release/bundle
```

CI 里同样会跑到的检查：

```bash
pnpm fmt:check                   # prettier 格式检查（含 Tailwind 类序）
pnpm typecheck                   # tsc --noEmit
pnpm build                       # tsc -b && vite build
pnpm test                        # 单元测试（Vitest，走假 Tauri IPC）
pnpm test:e2e                    # 端到端（Playwright，自己会起 dev server）
cd src-tauri
cargo fmt -- --check
cargo clippy -- -D warnings
cargo check
cargo test
```

从源码构建还需要 Node.js 20 或更高版本、pnpm 10，以及带 MSVC 目标的 stable Rust 工具链和 Tauri 构建所需的 WebView2 工具。代码库的模块级约定见 [AGENTS.md](AGENTS.md)。

## 参与贡献

欢迎在 [Eververdants/AppAudioRouter](https://github.com/Eververdants/AppAudioRouter) 提 Issue 或 Pull Request。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)，并且**一个提交只做一件事**。

## 许可证

[MIT](LICENSE) © 2026 Eververdants
