<p align="center">
  <img src="src/assets/app-icon.png" width="96" alt="App Audio Router 图标：一段音频波形分裂成两个箭头">
</p>

# App Audio Router

**Windows 每应用音频路由工具：把某个程序的音频同时送到多台播放设备，并且每台设备都能单独设置延迟补偿与音量。**

<p align="center">
  <a href="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml"><img alt="CI 状态" src="https://github.com/Eververdants/AppAudioRouter/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="版本 2.1.0" src="https://img.shields.io/badge/version-2.1.0-0891b2">
  <img alt="平台：Windows 10 与 Windows 11，64 位" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6">
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-3da639"></a>
  <img alt="技术栈：Tauri 2、Rust 与 React 19" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React%2019-24C8DB">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

> **App Audio Router 是一款面向 Windows 10 / Windows 11 的免费开源桌面应用，可以把单个应用程序的音频路由到你指定的播放设备。** 它能让同一个程序的声音同时输出到多台设备，并且可以逐台微调——用延迟补偿把蓝牙耳机和有线音箱对齐，用音量把各台设备的响度拉平。全部功能由单一原生程序直接调用 Windows Core Audio API 完成：既不需要安装虚拟声卡驱动，也不依赖任何第三方可执行文件。

---

## 这是什么

App Audio Router（简称 **AAR**）是一个 Windows 每应用音频路由工具。Windows 本身只允许一个程序同时向一路输出播放声音，App Audio Router 解除了这个限制：选中一个程序、选中一台或多台播放设备，它的声音就会实时送到全部设备上，**不需要重启该程序**。

它面向的是普通用户而不是音频工程师。没有混音矩阵、没有虚拟声卡、也不用装驱动——整个应用只有一个窗口：左侧是进程列表，中间是**同心圆路由盘**（中心是选中的进程，外环是你的播放设备），窗口拉宽之后右侧还会出现运行日志。

| | |
|---|---|
| **定位** | Windows 每应用音频路由（一个应用 → 多台设备） |
| **平台** | Windows 10 / Windows 11，64 位 |
| **当前版本** | 2.1.0 |
| **安装包** | 见 [Releases](https://github.com/Eververdants/AppAudioRouter/releases)，MSI 或 NSIS 安装程序 |
| **许可证** | MIT |
| **界面语言** | 简体中文、English |
| **外部依赖** | 无——不需要虚拟声卡驱动，也没有辅助进程 |
| **技术栈** | Tauri 2、Rust、React 19、TypeScript、TailwindCSS、Vite |
| **源码** | https://github.com/Eververdants/AppAudioRouter |

## 界面截图

同一组路由在两种主题下的样子：`Music.exe` 同时输出到蓝牙耳机、HDMI 输出与 USB 耳机，每台设备下方是本机的延迟（毫秒）与音量（百分比）。

![App Audio Router 把 Music.exe 同时路由到三台设备——蓝牙耳机 WH-1000XM5、HDMI 输出与 USB 耳机——每个设备节点下方显示各自的延迟与音量](docs/images/app-audio-router-light.png)

![同一条多设备音频路由在深色主题下的显示效果](docs/images/app-audio-router-dark.png)

## 功能特性

### 路由

- **一个应用 → 多台设备。** 可以选中一个或多个进程（`单击` 单选，`Ctrl`+`单击` 多选），再选中一台或多台设备，声音会同时镜像到全部设备。
- **即时生效。** 正在运行的程序会被直接改到选中的设备上，不需要重启，也不需要重开设置窗口。
- **有序的设备列表。** 第一台设备成为该程序的原生输出端点，由 Windows 直接播放；其余每台设备都会收到一路实时的音频副本。
- **随时停止。** 停止路由后，程序回到当前系统默认播放设备。
- **自动记忆。** 路由规则按可执行文件名保存，该程序下次出声时自动恢复。

### 逐设备微调

- **延迟补偿**——每台设备一个有符号毫秒值，用来把"快"的设备对齐到"慢"的设备，例如让有线音箱对齐蓝牙耳机（后者的编解码与缓冲本身就有硬件延迟）。范围与步进都可配置（范围 ±1/2/5/10 秒；步进 1/10/50/100/1000 ms，默认 10 ms）。
- **音量平衡**——每台设备一个 0–100 % 的值，把该设备相对"同组里最响的那台"做衰减，让轻的耳机和响的音箱拉到同一水平。
- **数值即控件**——横向拖动、滚轮、方向键（按住 `Shift` 十倍步进），或点击后直接键入精确值。两个数值都挂在设备节点下方，共用同一套操作方式。

### 不占地方

- **列表实时更新**——设备列表与进程列表自己跟着音频引擎走：插上耳机、某个程序开始或停止播放，不用点刷新列表也会跟上。用的是 Core Audio 自己的变更通知，不是定时器。
- **系统托盘**——运行期间托盘图标常驻：左键显示或隐藏窗口，右键菜单是「显示 / 隐藏」与「退出」。
- **关闭到托盘**——可选：点关闭只隐藏窗口，路由继续生效，屏幕上不再占一个窗口。此项默认关闭；托盘菜单里的**退出**才是明确停止路由的动作。
- **开机自动启动**——可选：在你自己的用户下登记一条启动项（`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`），登录时静默进托盘、不弹窗口，不需要管理员权限。同一个开关可以关掉，任务管理器 → 启动应用里也能关掉；开关读的就是注册表本身，所以它显示的永远是实际状态。

### 界面与开销

- **同心圆路由界面**——进程在中心、设备在外环，连线表示当前已生效的路由，应用路由时有涟漪反馈。
- **明暗双主题**，中英双语，都在标题栏一键切换；主题与语言在首帧之前就已生效，启动时不会闪一下白屏。
- **后台开销低**——程序从不轮询音频引擎，只在 Windows 报告「有东西变了」时才重读列表；重读之后如果屏幕上没有任何变化，连日志都不多写一行。
- **冷启动快**——窗口先隐藏创建、首帧绘制完成后再显示（Rust 侧另有看门狗兜底），设备枚举等到首帧之后的空闲时机才发起，发布配置也针对"体积小、映像紧凑"调过（LTO、单一 codegen unit、剥离符号、`panic = "abort"`）。

## 与其它方案对比

| 能力 | **App Audio Router** | Windows 自带的按应用输出 | 虚拟声卡混音方案（Voicemeeter / VB-CABLE 一类） | 按应用切换默认设备（EarTrumpet 一类） |
|---|---|---|---|---|
| 一个应用同时输出到多台设备 | **支持** | 不支持，一个应用只能选一路 | 支持，通过混音总线 | 不支持 |
| 对正在运行的程序即时生效 | **支持** | 支持 | 支持 | 支持 |
| 逐设备延迟对齐（蓝牙同步） | **支持**，每台设备一个有符号毫秒值 | 不支持 | 需手动逐总线设置 | 不支持 |
| 逐设备响度平衡 | **支持**，每台设备 0–100 % | 不支持 | 支持，用总线增益 | 不支持 |
| 按程序记住路由 | **支持**，自动记忆 | 支持（两者本质是同一个 Windows 设置） | 在 Windows 里配置，混音器本身不记 | 继承 Windows 的按应用设置 |
| 是否需要虚拟声卡驱动 | **不需要** | — | 需要 | — |
| 费用 | **免费，MIT 开源** | 随 Windows 提供 | 免费或自愿付费 | 免费，MIT 开源 |

*其它几列描述的是这些方案公开文档中的一般行为，具体功能请以各自的官方文档为准。*

## 系统要求

- **Windows 10 或 Windows 11，64 位。**
- WebView2 运行时——Windows 11 自带，装有 Microsoft Edge 的 Windows 10 也基本都有。
- 安装版就只需要这些：不用装声卡驱动、不用装服务、没有第三方可执行文件。

从源码构建还需要 Node.js 20 或更高版本、pnpm 10，以及带 MSVC 目标的 stable Rust 工具链和 Tauri 构建所需的 WebView2 工具。

## 安装

1. 打开 [Releases](https://github.com/Eververdants/AppAudioRouter/releases) 页面。
2. 从最新版本下载 `.msi` 安装包（或 NSIS `.exe` 安装程序）。
3. 安装后启动 **App Audio Router**。

想自己构建请见 [从源码构建](#从源码构建)。

## 快速上手

1. **先在要路由的程序里放点声音。** 程序只有拥有活动音频会话时才会出现在进程列表里——路由是按会话走的，不是按快捷方式。
2. **在进程列表里选中它。** 单击选中一个进程，或 `Ctrl`+`单击` 多选，一次路由应用到全部选中的进程。
3. **在外环点击目标播放设备。** 节点上的序号徽标就是顺序：第一台是主设备，其余每台都会得到一份镜像副本。
4. **点击中心的进程圆盘应用路由**（`路由到 N 台设备`）。路由生效后，对应设备节点上会出现状态圆点。
5. **需要时逐台微调。** 拖动设备节点下方的数值，即可设置该设备的延迟（毫秒）与音量（百分比）。
6. **在设置里打开"自动记忆"**，该程序下次出声时会自动恢复这条路由。

## 延迟补偿原理

同一段音频送到两路输出，只要其中一路是蓝牙耳机，听起来就不会同步：编解码和耳机自身的缓冲带来了有线通路没有的延迟。延迟补偿就是让声音在同一时刻到达两台设备。

- **每台设备各自保存一个有符号毫秒值**，基准是应用程序的音频，而不是"以某台设备为准"。
- **正值把该设备往后压；负值则把它标记为整组里最早的一台**，改为把其它设备抬起来。
- **软件只能加延迟、不能减延迟。** 因此组内最早的那台就是基准：它由 Windows 直接播放，其余设备按差值被往后压。你配置的**相对差一定被精确还原**，绝对值会被归一化到最早的那台。
- **路由按延迟从小到大应用**，所以最早的那台通常就是主设备（Windows 直连的那台）。运行中把某个延迟调小，只会让整组平移，不会产生爆音。
- **范围与步进都可以自己定**（设置 → 延迟补偿）：范围 ±1/2/5/10 秒，步进 1/10/50/100/1000 ms（默认 10 ms）。缩小范围时，超出新范围的已存数值会被钳制。

## 音量平衡原理

延迟解决的是声音**什么时候到**，音量解决的是每台设备**有多响**。

- **每台设备一个 0–100 % 的值。** 100 % 表示原样输出；数值越低衰减越多；0 % 即静音。
- **这个值是相对"同组里最响的那台"而言的。** 引擎按 `自身 / 最大值` 缩放每一路镜像，所以软件增益只能衰减——最响的那台就是基准，其余设备向它对齐。
- **主设备（Windows 直连的那台）自己的数值不会被应用在它身上**，但它依然参与基准计算，因此它决定了其它设备要被压低多少。
- 音量按设备保存，并会即时推送到正在运行的路由上，改完立刻能听出来。

## 工作原理

| 步骤 | 做了什么 |
|---|---|
| 1 | 用 `IMMDeviceEnumerator` 枚举当前活动的渲染（播放）端点。 |
| 2 | 用 `IAudioSessionEnumerator` 枚举当前持有音频会话的进程。 |
| 3 | 用 `IPolicyConfig` 把选中进程的会话（全部角色）指向目标端点——与 Windows 自带的按应用输出设置是同一套机制。 |
| 4 | 对其余每台设备，用 **WASAPI 进程回环（process loopback）** 按 PID 抓取音频，再喂给目标设备上的 `IAudioClient` 渲染客户端。延迟用 ring buffer 的积压实现（静音是**加在音频前面**，绝不是后面，所以提高延迟时不会先冒出一段声音）；音量则是写设备之前逐采样施加的增益。 |
| 5 | 采样格式从端点的 `WAVEFORMATEX` 解析：float32、float64、PCM 16/24/32 会被缩放，认不出的格式原样透传而不是乱改；增益恰好为 1.0 时直接短路，所以 100 % 时这条通路不付任何代价。 |
| 6 | 路由规则、延迟、音量都以 JSON 保存在应用数据目录下（`route-memory.json`、`device-delays.json`、`device-volumes.json`）。 |
| 7 | 每个复制引擎结束（用户停止、进程退出或出错）都会通过 `duplication-stopped` 事件通知前端；跨越应用重启仍然存活的路由会在启动时对账，保证界面状态与实际情况一致。 |

路由规则以**可执行文件名**为键，而不是 PID，所以记忆下来的路由在重启后依然有效。

## 技术栈

| 层级 | 技术 |
|---|---|
| 桌面框架 | Tauri 2 |
| 前端 | React 19 + TypeScript（strict） |
| 样式 | TailwindCSS 3（utility-first + CSS variables） |
| 动画 | Motion（`framer-motion`） |
| 构建 | Vite 6 |
| 状态 | Zustand |
| 国际化 | i18next / react-i18next（简体中文、English） |
| 后端 | Rust（edition 2021）+ 官方 `windows` crate——直接调用 Core Audio，无第三方音频库 |

## 项目结构

```
AppAudioRouter/
├── src/                          # React 前端
│   ├── components/
│   │   ├── ConcentricRouter.tsx  # 同心圆路由盘：设备节点 + 标题
│   │   ├── DeviceAnnotation.tsx  # 设备节点下方的延迟 / 音量标注行
│   │   ├── ProcessList.tsx       # 有音频会话的进程
│   │   ├── SettingsPage.tsx      # 设置页：主题 / 语言 / 路由 / 后台 / 延迟 / 关于
│   │   ├── LogPanel.tsx          # 运行日志
│   │   ├── TitleBar.tsx          # 自制无边框标题栏
│   │   └── ui/                   # Switch、SegmentedControl、ScrubReadout 等基础控件
│   ├── hooks/                    # useTheme、useLanguage、useDelayValue、useBackendEvent、useFitScale
│   ├── stores/routerStore.ts     # Zustand store
│   ├── i18n/locales/             # en.json、zh-CN.json
│   ├── lib/                      # invoke 封装、延迟计算、共享类型
│   └── styles/index.css          # Tailwind 入口 + 主题 CSS variables
└── src-tauri/                    # Rust 后端
    └── src/
        ├── main.rs               # 入口，注册命令 + 关闭拦截
        ├── commands.rs           # Tauri 命令（invoke handler）
        ├── config.rs             # 路由 / 延迟 / 音量 / 外壳设置持久化
        ├── tray.rs               # 托盘图标、菜单与窗口开关
        ├── autostart.rs          # 开机自启（HKCU Run 项）
        └── audio/
            ├── devices.rs        # IMMDeviceEnumerator 设备枚举
            ├── sessions.rs       # IAudioSessionEnumerator 会话枚举
            ├── routing.rs        # IPolicyConfig 按进程路由
            ├── duplication.rs    # WASAPI 进程回环复制引擎
            └── notifications.rs  # 设备与会话变更回调
```

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
pnpm typecheck                 # tsc --noEmit
pnpm build                     # tsc -b && vite build
cd src-tauri
cargo fmt -- --check
cargo clippy -- -D warnings
cargo check
```

CI 流程：前端类型检查与构建跑在 Linux 上，`cargo fmt` / `check` / `clippy` 跑在 Windows 上，打 tag 发版前还会先执行 `cargo audit`。

## 常见问题

### App Audio Router 是免费的吗？

是。它以 MIT 许可证开源，没有付费版本，也不需要注册账号。

### 能让同一个应用同时输出到两台（或多台）设备吗？

可以，这正是它的主要用途。在外环选中多台设备后应用路由即可：第一台由 Windows 原生驱动，其余每台设备都会实时收到同一路音频的镜像副本。

### 需要像 VB-CABLE 那样的虚拟声卡驱动吗？

不需要。路由、复制、延迟与增益全部由应用的 Rust 程序直接调用 Windows Core Audio API 完成，不会向音频栈里安装任何东西，卸载后也不会残留驱动。

### 对已经在运行的程序有效吗？

有效。路由是作用在实时音频会话上的，程序不需要重启——正在播放的游戏或浏览器标签页会在播放中切到新设备。

### 能解决蓝牙耳机和有线音箱之间的延迟不同步吗？

可以，这就是延迟补偿的用途。先估出蓝牙设备落后多少，再把"快"的那台设备设成对应的正值延迟（例如 `+180 ms`）。正值把设备往后压；负值表示这台是整组最早的一台。

### 为什么我的程序没有出现在进程列表里？

程序只有在持有活动音频会话时才会出现，所以先在它里面播放声音——列表会自己注意到，或者点**刷新**。使用 ASIO 或 WASAPI 独占模式的程序不会向系统音频引擎创建会话，因此不会出现在列表里；系统关键进程也被有意排除在路由之外。

### 配置保存在哪里？

以纯 JSON 保存在应用数据目录下：`route-memory.json`（可执行文件 → 设备列表）、`device-delays.json`（设备 → 毫秒值与配置的范围）、`device-volumes.json`（设备 → 百分比）以及 `app-settings.json`（关闭按钮是否只隐藏到托盘）。主题与语言属于窗口自己的界面偏好，存在它的 localStorage 里。唯一不在这些文件中的是那条可选的开机启动项，它在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下——「开机自动启动」开关读的也正是它。记忆的路由以可执行文件名为键，所以不管程序从哪里启动都适用。

### 它会在后台常驻或轮询音频设备吗？

不做轮询，也没有后台服务。程序注册的是音频引擎自己的变更通知，只有 Windows 报告「有东西动了」才会重读列表——设备与进程列表的实时更新就是这么来的。除此之外，只有在你刷新列表、调整设备数值或应用路由时才会与音频引擎通信。路由生效期间，对应进程的复制引擎会运行；一旦停止路由，引擎就被拆除。

### 把窗口关掉以后还在路由吗？

默认情况下，关闭窗口就是退出程序，依赖复制引擎的那份声音随之停止。打开**设置 → 后台运行 → 关闭窗口时最小化到托盘**之后，关闭按钮只隐藏窗口：路由继续生效，托盘图标可以把窗口唤回来。托盘菜单里的**退出**无论开关状态都会停止一切。

### 可以开机自动启动吗？

可以。**设置 → 后台运行 → 开机自动启动** 只在你当前用户下的 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写一条值：不碰 `HKLM`，不需要管理员权限，启动时也不弹窗口——直接进托盘，记忆路由在你打开任何程序之前就已就绪。程序是把这条注册表值当作唯一真相来读的，所以你在任务管理器里关掉启动项，设置里的开关也会跟着变。

### 支持 macOS 或 Linux 吗？

不支持。路由机制建立在 Windows Core Audio 之上，因此仅支持 Windows（Windows 10 / 11，64 位）。

## 限制与注意事项

- 程序必须在运行且正在发声才会出现在进程列表里——路由针对的是活动音频会话，从不发声的程序没有可搬动的东西。
- 记忆的路由按可执行文件名匹配，不区分完整路径，也不记录 PID。
- 延迟补偿只能**增加**延迟。组内最早的那台是对齐基准，无法被提前——这也是路由按延迟顺序应用的原因。
- 镜像是为了稳定而缓冲的（约 100 ms 的管线延迟），目的是让各镜像在同一时刻播放同一个采样。镜像之间的对齐是精确的；镜像相对主设备（由 Windows 原生播放）的这点偏移是"抓取再渲染"本身带来的。
- 音量只能衰减，所以组内最响的那台就是基准，无法被压到比程序原本给它的电平更低。
- 系统关键进程的路由请求会被拒绝，而不是半途应用。

## 参与贡献

欢迎在 [Eververdants/AppAudioRouter](https://github.com/Eververdants/AppAudioRouter) 提 Issue 或 Pull Request。提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)，并且**一个提交只做一件事**，保持 diff 精简；代码库内的具体约定见 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE) © 2026 Eververdants
