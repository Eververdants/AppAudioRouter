# 后台常驻、实时刷新与端点生命周期（专题）

> 本文是 [AGENTS.md](../../AGENTS.md) 的专题延伸。改托盘、单实例、自启、启动提示、通知线程（`notifications.rs`）、复制引擎（`duplication.rs`）、端点分配（`routing.rs`）之前先读这里；每条 ⚠️ 都是踩过的坑。

---

## 后台常驻与实时刷新（2.1 起）

### 托盘（`tray.rs`）

- 托盘图标**常驻**：左键开关窗口，右键菜单只有「显示/隐藏」和「退出」。`Quit` 走 `app.exit(0)`，是唯一会拆掉复制引擎的出口；退出都会经过 `RunEvent::ExitRequested`，在那里交还本进程写过的端点分配（见下面「每应用端点分配的生命周期」）。
- 菜单标签是**原生控件**，读不到 i18next → 由前端在挂载和语言切换时调 `set_tray_labels(t('tray.show'), t('tray.quit'))` 下发。不要指望 Rust 侧自己翻译，也不要用 `set_menu()` 换整个菜单（换完托盘的事件路由就不再认那些条目）。
- `close_to_tray` 存在 `app_data_dir/app-settings.json`，**默认 false**：发版不该悄悄改掉老用户按 X 的语义。为 true 时 `main.rs` 的 `WindowEvent::CloseRequested` 里 `api.prevent_close()` + `hide()`。
- 这个判断在 **Rust**，所以设置必须在后端。**只有 Rust 需要知道的设置才进 `app-settings.json`**——主题/语言/步进仍然走 localStorage，别顺手搬过去。
- 新增 Tauri 命令**不需要**动 `capabilities/`：ACL 只管插件命令，`generate_handler!` 注册的应用自有命令默认可调（`apply_route` 等一直没有权限条目就是证据）。要改的是窗口按钮那类，见 AGENTS.md 的「安全注意事项」。

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

## 引擎的唤醒成本（2.2 起）

一条路由常驻就是一个引擎常驻，而引擎的成本**不在 CPU 百分比里**——它落在调度唤醒次数上。任务管理器把一个每 10 ms 醒一次的线程显示成几乎没有占用，风扇曲线却看得见，因为它一直进不了包 C-state。所以这个模块里每一处等待都要能说出自己是被什么唤醒的：

- **事件驱动的渲染客户端只被「喂」驱动**：客户端只要处于 `Start` 状态，就每个音频周期被信号一次，**与有没有东西可播无关**。所以「永远写满缓冲、静音也用 `AUDCLNT_BUFFERFLAGS_SILENT` 写」的写法会让设备流永不空闲，每路镜像稳定约 100 次/秒，长期不变。修法是**源静默后停放**：捕获侧为每个非静音包盖时间戳（`note_audio`），某路镜像缓冲排空且源静默超过 `SOURCE_IDLE_MS`（1.5 s）就 `Stop()` 掉它的客户端（`park_mirror`），下一个包直接唤醒该线程并 `Start()` 回来。停放只会丢掉静音：`SILENT` 包从不入环，且停放那一刻设备里存的也是静音，所以两个方向都听不见。**不要退回「一直写静音」**——那正是风扇投诉的来源。
- **唤醒必须显式，超时只能是兜底**：渲染线程用 `std::thread::park_timeout` 等，捕获侧用 `MirrorChannel::wake()`（`Thread::unpark`）唤醒；「先查条件、再停放」加上 token 语义保证了不会丢唤醒，`PARK_POLL` / `GATE_POLL` 的 250 ms 是「万一没醒」的上限而不是机制本身。**新增任何停放点都要在被唤醒那一侧接上 `wake()`**：`open_gate_when_ready`、`DuplicationManager::stop`、`capture_session` 退出前各有一处，缺一处就是让捕获线程陪着等完整个兜底超时。`Thread::unpark` 只对 `park_timeout` 有效，**对 `WaitForSingleObject` 无效**，两者不能混用。
- **唤醒计数是仪表**：`MirrorChannel.wakeups` / `EngineShared.capture_wakeups` 只在引擎退出时汇总成一行 `info!`，没有任何音频路径读它。改循环节奏时用它对照前后，比看任务管理器可靠。
- **空闲引擎唯一还在做的事就是存活性检查**，所以它不能每次都多开一对句柄：`process_alive` 复用已打开的句柄读创建时间（`creation_time_of`）。同理，不要为了「以后可能有用」在每个周期里加系统调用。
- **已知且接受的取舍**：镜像停放期间设备被拔掉不会立刻报 `duplication-mirror-failed`，而是推迟到音频恢复、真正要写设备的时候。原实现也不是靠超时发现设备消失的（超时分支只 `continue`），而是靠写失败，而停放时不写。设备列表本身仍由 `audio-changed` 实时更新。

## 每应用端点分配的生命周期（2.1.1 起）

路由期间 `routing.rs` 写下的不是一条"临时路由"，而是音频服务为**可执行文件**保存的一条 Per-app 默认端点记录：程序退出、本应用退出、乃至卸载之后它都还在，并且**优先于系统默认设备**。2.1.0 的「停止路由」是把这条记录改写成当时的默认设备再留在那儿，于是用户之后手动切默认设备对这个程序失效（现场表现就是"停止之后就切不了播放设备了"）。规则：

- 写入 = 槽 25 `SetPersistedDefaultAudioEndpoint`；同槽传 **null HSTRING 即清除这条记录**（音量合成器里的「默认」走的就是同一条路）；槽 26 `GetPersistedDefaultAudioEndpoint` 读回，没有记录时返回 `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)` = `0x80070490`。槽 27 的 `ClearAllPersistedApplicationDefaultEndpoints` **禁止使用**：它会连用户在音量合成器里手设的分配一起清掉。
- **任何写端点的路径都必须登记 `PinnedRoutes`**：`mark` = 活路由（重置/清扫要放过它），`mark_returned` = 停止时 Windows 拒绝释放、于是把它指回当前默认设备的（重置**必须**能清掉它，否则用户只剩"重启应用"这一条路）。登记是唯一能把"我们钉的""用户自己钉的""已经不算路由的"三者分开的东西。
- 归属判定**按可执行文件、不按单个 pid**：分配是按 exe 存的，而一个程序可以有多个带会话的进程（浏览器就是），清扫时挑中的 pid 未必是我们路由的那个。清理前要问"这个 exe 是否还有属于我们的活路由"，问"这个 pid 是不是我们的"会漏。
- 清除后必须**读回校验**（`release_default_endpoints` 已这么做），并把结果回给前端；Windows 拒绝时要报出仍固定在哪台设备，不许假装成功。
- 四条归还路径缺一不可，各自覆盖一种"分配比路由活得久"的情形：停止路由（`stop_route`）、退出应用（`main.rs` 的 `RunEvent::ExitRequested` → `release_pinned_blocking`，独立线程 + 有界等待，绝不能让音频服务卡住退出）、程序在路由期间退出后下次出声（`release_stale_routes`；音频服务按 pid 寻址，所以只能借它新的进程去释放）、设置页「重置每应用音频输出」（`reset_pinned_endpoints`，清旧版本留下的，跳过仍在路由的 pid）。
- 新增任何"改变某程序输出"的代码路径，都要把这一套接上：写 → 登记 → 停止时归还。少一步就是把用户锁在错误的设备上，而且界面上没有任何东西能解释为什么。
- 系统关键进程在 `set_process_default_device` 入口被 `is_protected_process` 拒绝（`PROTECTED_EXES` + pid 0/4），两份 README 都承诺过这件事——不要绕过这个入口另开 COM 写入路径。

## 启动提示（`install.rs`，2.1.1 起）

首次启动和升级后的首次启动各要说一句话：**全新安装进全屏向导**（`StartupWizard`，四步：欢迎 → 看板怎么读 → 送入载体 → 后台习惯；载体一步复用 `lib/carrierDetect.ts` 的探测，完成/跳过/`Escape` 都走同一条 ack），**装过 2.1.0** 则在弹窗里直接提供「重置每应用音频输出」。升级是警告不是导览，所以升级永远走小弹窗、不走向导。2.1.0 是唯一会把固定端点留在 Windows 里的版本（见上一节；2.1.1 起四条归还路径闭环，从那以后升上来的机器无事可清、**不再弹这个窗**），而应用分不出「2.1.0 留下的」和「用户在音量合成器里手设的」——所以既不静默清理，也不装作没事，而是问一次。

- ⚠️ **判定必须在建窗口之前完成**（`main.rs` 里 `tauri::Builder` 之前），依据是本应用自己的两个目录：`%APPDATA%\<identifier>`（配置文件，只有存过东西才存在）和 `%LOCALAPPDATA%\<identifier>\EBWebView`（WebView2 档案，任何版本跑过一次就有）。挪进 `setup()` 就晚了：这一次启动自己会建出 EBWebView，全新安装会被认成升级。
- 目录取自环境变量而不是 `app.path()`，因为判定时机在 App 存在之前；`identifier` 从 `generate_context!().config()` 读，别手抄字面量（会和 `tauri.conf.json` 漂移）。
- 「上次运行的版本」记在 `app_data_dir/install-state.json`，**在用户点掉提示时写**（`ack_startup_notice`），所以同一版本只提示一次；升级是否再提示**只看上次的版本是不是 2.1.0**，从 2.1.1 及以后升上来一律沉默。install-state.json 比 2.1.0 晚出现，所以现实中「装过 2.1.0」的证据就是**目录在、记录不在**（`ran_before()` 且读不到版本）。写失败只记日志，不能让提示卡在那里。
- `StartupNotice { kind, previous_version }` 的 `kind`（kebab-case）是前后端契约，`src/lib/types.ts` 的联合类型按字面量认它，`install.rs` 里有测试钉住；新增第三种之前先想清楚前端怎么显示。
- 弹窗里那个重置按钮复用 `resetPinnedEndpoints`，不要再写一条清理路径；文案必须写明「会清掉当前正在运行的程序」，否则用户会以为它只清旧版本留下的东西。
- **开发期测试入口**：debug 构建读环境变量 `AAR_STARTUP_NOTICE`（取值 `first-run` / `upgrade`），强制本次启动提示的种类——ack 过一次的机器否则永远见不到向导（状态文件正在尽职）。release 构建不读这个变量；强制提示被点掉时照常写 `install-state.json`。
