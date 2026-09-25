# App Audio Router — Website

App Audio Router 桌面应用的落地页(landing page),与主项目
[Eververdants/AppAudioRouter](https://github.com/Eververdants/AppAudioRouter)
使用同一套技术栈与视觉语言。

## 功能定位

面向普通 Windows 用户的单页介绍站,包含:

- **Hero 区** — 产品名、一句话定位(与主 README 相同的 tagline)、下载主 CTA,以及一幅复刻应用"同心圆路由盘"的 SVG 插画(中心进程 + 外环设备 + 弧形路由线 + 序号徽标 + 涟漪反馈);
- **核心能力** — 5 张功能卡片(一个应用 → 多台设备 / 逐设备延迟补偿 / 逐设备音量平衡 / 免驱动零依赖 / 自动记忆后台常驻)+ 1 张系统要求卡片;
- **典型使用场景** — 4 个场景卡片 + 明暗两张真实应用截图;
- **安装引导** — 三步安装、系统要求、"从源码构建"命令块、Releases 直达按钮;
- **页脚** — GitHub 仓库、Releases、Issues、双语文档与许可证链接。

支持 **简体中文 / English** 切换(i18next,与主应用同一套 i18n 引导模式)与
**明暗双主题**(CSS 变量 + `prefers-color-scheme`,首帧前内联脚本防闪烁)。

## 启动方式

```bash
pnpm install        # 或 npm install
pnpm dev            # 开发服务器 http://localhost:5173
pnpm build          # 产物输出到 dist/(tsc -b && vite build)
pnpm preview        # 本地预览 dist/
```

脚本命名与主项目一致(`dev` / `build` / `preview` / `typecheck` / `fmt`)。
主项目使用 pnpm 10;本机若没有 pnpm,用 npm 亦可,依赖版本范围与主项目 package.json 完全一致。

## 技术栈

与主项目对齐:Vite 6 · React 19 · TypeScript(strict)· TailwindCSS 3 ·
framer-motion · i18next / react-i18next。刻意**没有**引入 Tauri、Zustand 等
仅桌面端需要的依赖。

## 目录结构

```
AppAudioRouter-Website/
├── index.html                  # 入口;内联首帧主题/语言启动脚本(模式同主应用)
├── public/
│   ├── icon.png                # 应用图标(复制自主项目 src/assets/app-icon.png)
│   └── screenshots/            # 界面截图(复制自主项目 docs/images/)
└── src/
    ├── components/
    │   ├── Header.tsx          # 吸顶玻璃导航(锚点 / 主题 / 语言 / GitHub)
    │   ├── Hero.tsx            # 首屏:徽标、标题、定位、CTA
    │   ├── RouterIllustration.tsx  # 同心圆路由盘 SVG 插画
    │   ├── Features.tsx        # 核心能力卡片
    │   ├── Scenarios.tsx       # 使用场景 + 真实截图
    │   ├── Install.tsx         # 安装步骤 / 系统要求 / 源码构建
    │   ├── Footer.tsx          # 页脚(仓库链接、许可证)
    │   ├── Section.tsx         # 统一的区块壳与标题排版
    │   └── icons.tsx           # 手绘 24×24 线性图标
    ├── i18n/                   # 引导脚本 + locales/(en.json、zh-CN.json)
    ├── hooks/useTheme.ts       # 主题 hook(同主应用,独立 storage key)
    ├── lib/site.ts             # 仓库 / Releases / Issues 链接与版本号
    └── styles/index.css        # 主题 token(复制自主应用)+ 环境光渐变
```

## 文案来源与占位说明

- **所有文案均改写自主项目 README / README.zh-CN(v2.1.0)的事实描述**,
  未虚构任何功能;场景一节的四个用例分别是"一应用多设备 / 延迟补偿 /
  音量平衡 / 自动记忆"的真实组合。
- 插画中的设备名与数值(如蓝牙耳机 `+180 ms · 70 %`)沿用 README 中
  蓝牙对齐示例的量级,仅作示意,不对应某台真实设备。
- 版本号统一维护在 `src/lib/site.ts` 的 `VERSION`,升级应用版本时与主
  README 同步修改。
- **待补充位置**:尚无公开的更新日志页 / 演示视频 / 下载镜像,如后续提供,
  在 `src/lib/site.ts` 中标注的 `TODO(placeholder)` 处添加即可。

## 与主项目的视觉一致性

- 主题 token(`--bg-* / --text-* / --accent / --glass-*`)逐字复制自主应用
  `src/styles/index.css`,`tailwind.config.ts` 与主应用完全一致;
- 玻璃拟态面板(`bg-glass` + `shadow-glass` + `backdrop-blur`)、强调色
  青色(cyan-600 / cyan-400)、Inter 字体均沿用主应用;
- 主题与语言偏好分别存储在 `aar-website-theme` / `aar-website-language`,
  与桌面应用的 storage key 隔离,互不影响。
