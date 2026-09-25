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
- **站点地址为占位**:canonical / og:url / sitemap / robots 中的 URL 假设
  部署在 GitHub Pages 项目页(`src/lib/site.ts` 的 `SITE_URL` 及
  `public/robots.txt`、`public/sitemap.xml`、`public/llms.txt`、
  `index.html` 中的静态写法)。确定正式域名后请同步替换这五处;若部署在
  子路径,还需给 Vite 配置 `base`。

## SEO 与 GEO

页面同时面向传统搜索引擎与生成式引擎(Answer Engine Optimization)做了优化:

- **静态元信息**(不依赖 JS,`index.html`):含关键词的标题与描述、
  `robots` 指令、canonical、Open Graph(含 `og:locale` 双语声明)与
  Twitter Card、绝对地址的分享图,以及语言无关的
  `SoftwareApplication` 结构化数据(名称/系统/版本/许可证/价格/功能列表)。
- **FAQPage 结构化数据**(`src/components/Faq.tsx`):由 FAQ 区块渲染所用的
  同一份 i18n 文案生成,随语言切换同步,保证结构化数据与可见内容一致。
- **FAQ 区块**:5 组问答全部改写自主项目 README 的 FAQ,用原生
  `<details>/<summary>` 实现——不展开也在 DOM 里,爬虫与 AI 引擎可直接引用。
- **`public/robots.txt`**:显式允许 Googlebot / Bingbot / Baiduspider,以及
  GPTBot、OAI-SearchBot、ClaudeBot、PerplexityBot 等生成式引擎爬虫。
- **`public/llms.txt`**:按 llms.txt 约定提供产品事实摘要与权威链接,
  便于回答引擎引用而不必解析整个页面。
- **`public/sitemap.xml`**:单页 sitemap。
- **无 JS 兜底**:`<noscript>` 中静态给出产品定位与下载链接。
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

## 与主项目的视觉一致性

- 主题 token(`--bg-* / --text-* / --accent / --glass-*`)逐字复制自主应用
  `src/styles/index.css`,`tailwind.config.ts` 与主应用完全一致;
- 玻璃拟态面板(`bg-glass` + `shadow-glass` + `backdrop-blur`)、强调色
  青色(cyan-600 / cyan-400)、Inter 字体均沿用主应用;
- 主题与语言偏好分别存储在 `aar-website-theme` / `aar-website-language`,
  与桌面应用的 storage key 隔离,互不影响。
