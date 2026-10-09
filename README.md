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
pnpm dev            # 开发服务器 http://localhost:5173/AppAudioRouter/
pnpm build          # 产物输出到 dist/(typecheck + vite build)
pnpm preview        # 本地预览 dist/(同样带子路径前缀)
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
├── index.html                  # 入口模板;内联首帧主题/语言启动脚本,元信息以
│                               #   %TOKEN% 形式由构建期填充(见 scripts/)
├── scripts/
│   └── site-meta.ts            # 构建期元信息:逐语言 HTML、JSON-LD、静态兜底、
│                               #   以及 public/ 下各文件的 token 替换
├── public/
│   ├── icon.png                # 应用图标(复制自主项目 src/assets/app-icon.png)
│   ├── screenshots/            # 界面截图(复制自主项目 docs/images/)
│   ├── robots.txt              # 显式允许搜索与生成式引擎爬虫
│   ├── sitemap.xml             # 双语 URL + hreflang 交替(构建期填日期)
│   ├── llms.txt                # 面向回答引擎的事实摘要与快速问答
│   └── site.webmanifest        # 站点名 / 图标 / 主题色
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
    ├── lib/site.ts             # 版本号、站点 URL、仓库 / Releases / Issues 链接
    ├── lib/faq.ts              # FAQ 条目顺序(渲染与静态兜底共用)
    └── styles/index.css        # 主题 token(复制自主应用)+ 环境光渐变
```

## 文案来源与占位说明

- **所有文案均改写自主项目 README / README.zh-CN(v2.1.1)的事实描述**,
  未虚构任何功能;场景一节的四个用例分别是"一应用多设备 / 延迟补偿 /
  音量平衡 / 自动记忆"的真实组合;FAQ 的七条问答逐条对应主 README 的 FAQ,
  含 2.1.1 的"停止后交还固定输出设备"与"程序为什么不在列表里"。
- 插画中的设备名与数值(如蓝牙耳机 `+180 ms · 70 %`)沿用 README 中
  蓝牙对齐示例的量级,仅作示意,不对应某台真实设备。
- 版本号统一维护在 `src/lib/site.ts` 的 `VERSION`。`index.html`、
  `sitemap.xml`、`llms.txt`、`site.webmanifest` 中的版本号与站点 URL 以
  token 形式在构建期注入,页头徽标 / 英雄区 / 页脚直接读 `VERSION`,所以升
  版本只需改这一处(外加 `package.json` 里给 npm 工具用的镜像值)。
- **待补充位置**:尚无公开的更新日志页 / 演示视频 / 下载镜像,如后续提供,
  在 `src/lib/site.ts` 中标注的 `TODO(placeholder)` 处添加即可。
- **站点地址**:部署在 GitHub Pages 项目子路径
  `https://eververdants.github.io/AppAudioRouter/`(见下文「部署」)。
  canonical / hreflang / og:url / sitemap / llms.txt / JSON-LD 全部由
  `SITE_URL` 派生;改用自定义域名或根路径时,只需同步 `src/lib/site.ts` 的
  `SITE_URL` 与 `vite.config.ts` 的 `base`。

## SEO 与 GEO

页面同时面向传统搜索引擎与生成式引擎(Answer Engine Optimization)优化。
核心前提是:**多数回答引擎(GPTBot、ClaudeBot、PerplexityBot 等)只抓原始
HTML、不执行 JS**,因此"爬虫能看到什么"由构建产物决定,而不是由 React 决定。

- **构建期模板**(`scripts/site-meta.ts`,Vite 插件):`index.html` 是模板,
  标题 / 描述 / OG / Twitter / canonical / hreflang / JSON-LD / `<noscript>`
  全部在构建时由 `src/lib/site.ts` 与两份 locale JSON 生成;构建额外产出
  `dist/en/index.html`,让英文拥有独立可收录的 URL。`public/` 下的
  `sitemap.xml` / `robots.txt` / `llms.txt` / `site.webmanifest` 同样在构建期
  填 token(版本号、构建日期、站点 URL、base)。
- **双语 URL + hreflang**:中文在站点根、英文在 `/en/`,两个文档互相声明
  `hreflang`(含 `x-default`),sitemap 内也带 `xhtml:link` 交替;`/en/` 路径
  优先于 localStorage 决定初始语言,而页面内的语言切换仍是即时切换、不跳转。
- **结构化数据**:静态 `@graph` 含 `Organization` / `WebSite` / `WebPage`(带
  `datePublished` 与 `dateModified`)/ `SoftwareApplication`(含 `screenshot`、
  `softwareRequirements`、`featureList`、`sameAs`、`releaseNotes` 与免费
  Offer);`FAQPage` 由 `src/components/Faq.tsx` 在运行时注入,与可见文案
  同语言、同内容,并随切换同步。
- **无 JS 兜底**:`<noscript>` 中是整页的语义化静态副本(定位、功能、场景、
  安装、系统要求、全部 FAQ、链接),由 locale JSON 生成——这是不执行 JS 的
  爬虫唯一能读到的正文,因此与页面可见文案同源、不会漂移。
- **`public/robots.txt`**:显式允许 Googlebot / Bingbot / Baiduspider 等搜索
  引擎,以及 GPTBot、OAI-SearchBot、ChatGPT-User、ClaudeBot、
  PerplexityBot、Google-Extended、Applebot-Extended、Amazonbot 等生成式
  引擎爬虫。
- **`public/llms.txt`**:按 llms.txt 约定给出可直接引用的事实清单、"它做不到
  什么"、快速问答与规格表,回答引擎不必解析整个页面。
- **`public/sitemap.xml`**:双语 URL,`lastmod` 取构建日期。
- **运行时同步**:切换语言时 `document.title`、`description`、`og:*`、
  `twitter:*` 一并更新,分享与索引看到的语言与屏幕上的一致。
- 截图 `<img>` 带固定 `width/height`(1800×1360)+ `loading="lazy"`,
  避免 CLS;页面为单屏语义化结构(每节一个 `<h2>`,卡片 `<h3>`)。

## 交互与微动效

- **英雄区路由盘是一个可交互 demo**(复刻应用核心手势):点击设备节点增删
  路由目标(序号徽标按选择顺序编号,1 号为主设备),点击中心盘应用/停止
  路由;应用时路由线有 pathLength 绘制动画与流动虚线,涟漪只出现在活动
  节点上;状态胶囊在「未在路由 / 已选 N 台 / 正在路由 N 台」间切换。空选
  状态下点击中心盘会左右轻晃提示,而不是无响应。
- **可访问性**:交互组带 `role="button"`、`aria-pressed` 与键盘
  Enter/Space 支持;`MotionConfig reducedMotion="user"` 尊重系统「减弱动态
  效果」设置,CSS 涟漪/流线动画同样包在 `prefers-reduced-motion` 媒体查询里。
- **卡片微交互**:`SpotlightCard` 提供跟随鼠标的径向光斑(写 CSS 变量实现,
  不触发重渲染)、悬浮上浮、描边强调与图标微旋转。
- **导航**:滚动 spy + `layoutId` 滑动高亮块;页头滚动后加深阴影。
- **按钮**:悬浮上浮、按压回弹、主按钮光泽扫过、主题图标旋转切换。
- **FAQ**:`grid-template-rows` 0fr→1fr 平滑展开,加号旋转 45°;答案始终
  挂载在 DOM 中,不破坏上一节的 GEO 可抓取性。
- **其他**:源码命令一键复制(带「已复制」反馈)、回顶按钮(spring 入场,
  滚过 600px 出现)、页脚链接滑移。

## 部署(GitHub Pages)

- 网站代码位于主仓库 **`Eververdants/AppAudioRouter` 的 `website` 分支**。
- 每次推送到 `website` 分支,该分支自带的 `.github/workflows/deploy.yml` 会
  自动 `npm ci && npm run build`,并把 `dist/` 通过 `actions/deploy-pages`
  发布到 https://eververdants.github.io/AppAudioRouter/ 。
- 首次启用前提:主仓库 Settings → Pages → Build and deployment → Source 选
  **GitHub Actions**(等价 API:`build_type=workflow`)。
- Vite `base` 固定为 `/AppAudioRouter/`;组件内的图标与截图路径用
  `import.meta.env.BASE_URL` 拼接,保证子路径下资源可用。

## 与主项目的视觉一致性

- 主题 token(`--bg-* / --text-* / --accent / --glass-*`)逐字复制自主应用
  `src/styles/index.css`,`tailwind.config.ts` 与主应用完全一致;
- 玻璃拟态面板(`bg-glass` + `shadow-glass` + `backdrop-blur`)、强调色
  青色(cyan-600 / cyan-400)、Inter 字体均沿用主应用;
- 主题与语言偏好分别存储在 `aar-website-theme` / `aar-website-language`,
  与桌面应用的 storage key 隔离,互不影响。
