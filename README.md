# Harness Desktop · DeepSeek Harness 桌面版

> 一个**全新独立构建**的 DeepSeek Harness 桌面客户端：基于 DeepSeek 官方开源的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 引擎，重新封装成 Windows 桌面应用，并**内置**了一整套独具特色的玻璃拟态 UI（Aqua）主题。开箱即用，无需安装任何开发环境。
>
> ⚠️ **非官方出品**：本项目不是 DeepSeek 官方应用，而是个人/社区基于官方开源项目二次构建的桌面封装。核心引擎 100% 来自官方开源代码，不修改官方功能，只做「桌面化 + 内置主题」的增强。

![GitHub Release](https://img.shields.io/github/v/release/colm20060530/harness-desktop)
![License](https://img.shields.io/github/license/colm20060530/harness-desktop)

![应用主界面](docs/app-screenshot.png)

## 目录

1. [项目特色](#项目特色)
2. [功能特性](#功能特性)
3. [系统要求](#系统要求)
4. [下载与安装](#下载与安装)
5. [快速开始](#快速开始)
6. [接入免费模型（示例一：Agnes AI）](#接入免费模型示例一agnes-ai)
7. [接入免费模型（示例二：智谱 GLM）](#接入免费模型示例二智谱-glm)
8. [数据存储与隐私](#数据存储与隐私)
9. [从源码构建](#从源码构建)
10. [项目结构](#项目结构)
11. [工作原理](#工作原理)
12. [常见问题 FAQ](#常见问题-faq)
13. [许可证与致谢](#许可证与致谢)
14. [版本发布](#版本发布)

---

## 项目特色

### 🧊 内置 Aqua 玻璃拟态 UI（本项目的招牌）

与官方 Web UI 相比，Harness Desktop 多了一层**完全内置、默认开启、不可卸载**的玻璃拟态主题（Aqua）：

- **毛玻璃面板**：顶栏、侧边栏、输入区、统计栏、轨迹视图全部变成半透明毛玻璃卡片；
- **双模式**：Mica 模式把布局重排为悬浮玻璃卡片（模糊/霜化可调）；兼容模式保持官方布局分毫不动，只把材质换成玻璃，其他插件的界面也会自动获得同样的质感；
- **动态背景**：内置流动流体背景（色相可调），或使用你自己的壁纸（保留比例、可调模糊与霜化）；
- **粒子鲸鱼**：deepseek.com/harness 同款粒子引擎 2D 移植版，悬浮在聊天区右侧；
- **质感细节**：深色模式下的侧边栏字标辉光铭牌、页面上下边缘渐隐、光标聚光与按压缩放等微交互；
- **一键还原**：设置 → 插件 → Glass theme 主开关关闭后，界面 100% 还原官方原版（只是开关，不是卸载）。

### 📦 桌面化增强

| 特性 | 说明 |
| --- | --- |
| 即装即用 | 内置 Node.js 24 运行时与完整 dsh 服务端，用户机器**无需**安装 Node/npm/Python/浏览器 |
| 独立窗口 | 告别浏览器标签页，双击图标即用 |
| 自动拉起服务 | 启动时自动在本地拉起后端服务（默认端口 3080，被占用时自动换空闲端口） |
| 插件自愈 | 每次启动自动检查并修复内置插件，卸载无法持久 |
| 单实例运行 | 重复启动只会聚焦已有窗口，不会开第二个服务 |
| 关闭即清理 | 关闭窗口自动结束本地服务进程，不留残留 |
| 独立数据目录 | 默认数据放在应用自己的目录，**不污染**官方 `~/.dsh` |

### 🧠 完整智能体能力（官方引擎）

Harness Desktop 不是聊天机器人，而是**任务型 AI 智能体**。你可以让它：

- **读写文件**：查看、创建、修改工作目录中的文件；
- **执行命令**：运行 PowerShell、调用本机程序；
- **并行干活**：启动多个后台任务、派出多个子代理分工协作；
- **规划长任务**：把复杂目标拆成步骤清单逐项推进，完成后汇总报告；
- **输出成品**：文档、代码、报告、PPT、图表直接以文件形式产出到工作目录；
- **轨迹回放**：切到「轨迹」视图查看 AI 每一步的完整记录（Token 用量、耗时、输入输出），全程本地渲染；
- **沙箱权限**：默认只能访问你选择的工作目录，越界操作需你逐次审批。

---

## 功能特性

| 类别 | 能力 |
| --- | --- |
| 对话 | 多会话管理、会话归档、中英文输入、上下文连续追问 |
| 工具 | 文件读写、命令执行、网页搜索、子代理、后台任务、技能（Skills） |
| 规划 | 目标拆解（Goals）、计划模式（Plan）、步骤清单实时推进 |
| 视图 | 对话视图、轨迹视图（回放/时间轴/搜索/区间聚焦） |
| 安全 | 只读 / 工作区读写 / 完全访问三档沙箱、权限升级审批、失败即拒绝 |
| 模型 | 默认 DeepSeek 官方模型；支持 OpenAI 兼容协议接入任意服务商 |
| 扩展 | 插件化架构（Cordis），可安装插件、自定义命令与工具 |
| UI | Aqua 玻璃拟态（内置、默认开启）、浅色/深色/跟随系统主题 |

---

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / Windows 11（64 位 x64；暂不支持 ARM 版、macOS、Linux） |
| 磁盘空间 | 安装约需 650 MB（安装包约 165 MB） |
| 内存 | 建议 4 GB 及以上 |
| 网络 | 软件启动与运行无需联网；与 AI 对话时需要联网调用模型服务商 API |
| 预装环境 | 无需 Node.js、npm、Python 或浏览器（全部内置） |

---

## 下载与安装

### 获取安装包

最新版本已发布到 GitHub Releases：[下载页面](https://github.com/colm20060530/harness-desktop/releases)。本地源码仓库中也保留了 `release/` 目录：

| 文件 | 说明 |
| --- | --- |
| `Harness-Desktop-Setup-1.0.0.exe` | 安装版：向导安装、创建桌面/开始菜单快捷方式、可在「应用和功能」中卸载 |
| `Harness-Desktop-Portable-1.0.0.exe` | 便携版：免安装，双击即用，适合 U 盘随身携带 |

两个版本功能完全相同、共用同一份数据目录，可任选其一。

### 安装步骤（安装版）

1. 双击 `Harness-Desktop-Setup-1.0.0.exe`；
2. 若出现 SmartScreen「Windows 已保护你的电脑」提示：点击 **更多信息 → 仍要运行**（软件暂未做代码签名，属正常提示，见 [FAQ Q1](#常见问题-faq)）；
3. 按向导选择安装目录（默认即可），勾选快捷方式；
4. 点击安装并完成。

### 静默安装（可选）

```powershell
Harness-Desktop-Setup-1.0.0.exe /S /D=D:\HarnessDesktop
```

> `/D=` 后跟安装目录，且必须是命令行**最后一个参数**。

### 卸载

- 安装版：Windows 设置 → 应用 → 已安装的应用 → Harness Desktop → 卸载；
- 便携版：删除 exe 即可；
- 卸载不会删除应用数据目录，如需彻底清理见 [第 8 节](#数据存储与隐私)。

---

## 快速开始

### 1. 首次启动

双击图标启动，应用会自动完成（首次约 10~30 秒）：

1. 在应用数据目录创建独立的 `dsh-home`；
2. 安装内置 Aqua 插件并建立模块链接；
3. 用内置 Node 运行时拉起本地 dsh 服务（`127.0.0.1:3080`，占用则自动换端口）；
4. 弹出桌面主窗口。

### 2. 选择工作目录

首次进入会要求选择 **Workspace Directory（工作目录）**——这是 AI 智能体"干活"的地方，它只能读写这个目录下的文件。请选一个专门存放 AI 工作成果的文件夹。

### 3. 配置 DeepSeek API Key

进入 **设置（Settings）→ 模型（Models）**，选择默认的 DeepSeek 官方通道，填入你自己的 API Key，即可开始对话。

> API Key 是你向模型服务商申请的个人密钥，请勿泄露；未配置 Key 时软件可正常启动，只是无法对话。

### 4. 开始对话

在底部输入框用自然语言描述需求，例如：

```text
帮我把当前工作目录下的所有文件列出来
写一份项目周报，保存为 markdown 文件
把这个文件夹里的日志分析一下，总结错误类型和出现频率
```

AI 会：规划步骤 → 调用工具（读写文件、执行命令）→ 检查结果 → 汇报进度 → 把产出文件保存到工作目录。

---

## 接入免费模型（示例一：Agnes AI）

Agnes AI 提供免费的多模态 API（文本/图像/视频）。下面演示在 Harness Desktop 中接入文本对话模型。

### ① 获取 API Key

1. 打开 Agnes 平台：<https://platform.agnes-ai.com>；
2. 注册 / 登录；
3. 进入 **Settings → API Keys → Create new secret key**，创建后立即复制保存（密钥以 `sk-` 开头，只显示一次）。

### ② 添加服务商

在 **设置 → 模型 → 添加服务商** 中按下表填写：

| 配置项 | 填写内容 |
| --- | --- |
| Provider ID | `agnes` |
| 显示名称 | Agnes |
| Base URL | `https://apihub.agnes-ai.cn/v1`（国内网络推荐）或 `https://apihub.agnes-ai.com/v1`（国际） |
| API 格式 | OpenAI 兼容 |
| API Key | 上一步获取的 `sk-` 开头密钥 |

### ③ 添加模型

| 模型 ID | 说明 | 上下文窗口 | 最大输出 |
| --- | --- | --- | --- |
| `agnes-2.0-flash` | 通用对话 / 编程 / Agent | 1,000,000（1M） | 64,000（64K） |
| `agnes-2.5-flash` | 新一代文本模型，编程 / Agent / 图片理解 | 1,000,000（1M） | 64,000（64K） |

> ⚠️ Agnes 的图像 / 视频模型走的是独立的 `/v1/images/generations`、`/v1/videos` 接口，**不是聊天对话接口**，无法直接在模型列表中添加调用；如需生图/生视频，请使用 Agnes 官方或社区提供的专用客户端/技能。

---

## 接入免费模型（示例二：智谱 GLM）

智谱 AI 开放平台提供免费普惠模型，适合日常对话与图片理解。

### ① 获取 API Key

1. 打开智谱开放平台：<https://open.bigmodel.cn>；
2. 注册并登录（手机号即可），按提示完成实名认证；
3. 进入 **API 密钥** 页面：<https://open.bigmodel.cn/usercenter/apikeys>；
4. 点击 **创建 API Key** 并复制保存（格式为 `{ID}.{密钥}` 两段式，中间以英文句点分隔）。

### ② 添加服务商

| 配置项 | 填写内容 |
| --- | --- |
| Provider ID | `bigmodel` |
| 显示名称 | GLM（智谱） |
| Base URL | `https://open.bigmodel.cn/api/paas/v4` |
| API 格式 | OpenAI 兼容 |
| API Key | 上一步获取的两段式密钥（需包含中间英文句点） |

### ③ 添加免费模型

| 模型 ID | 说明 | 上下文窗口 | 最大输出 |
| --- | --- | --- | --- |
| `glm-4.7-flash` | 免费文本模型，混合思考，适合对话与 Agent 任务 | 256,000（256K） | 64,000（64K） |
| `glm-4.6v-flash` | 免费视觉模型（VLM），支持图片理解 | 256,000（256K） | 64,000（64K） |

> 免费档通常有调用频率限制（RPM/TPM），遇到 429 限流稍等再试即可；平台还有更多付费模型（如 glm-5 系列），按需自行添加。

### 模型适配说明

Harness 是 DeepSeek 官方为自家模型打造的智能体框架：框架的指令格式、工具调用协议、上下文组织方式都围绕 DeepSeek 模型设计，因此**默认的 DeepSeek 官方模型适配最好**——工具调用（Function Calling）参数准确、长上下文稳定、Agent 任务体验最完整。

第三方模型走通用 OpenAI 兼容协议，**兼容可用**：日常对话、写作、简单任务没有问题；但在复杂嵌套工具、超长任务等场景下，偶发格式偏差或解析失败属于模型拟合度差异，不是软件故障。建议：日常用 DeepSeek 官方模型，Agnes / 智谱等免费通道作为备用或体验。

---

## 数据存储与隐私

| 数据类型 | 存储位置 |
| --- | --- |
| 应用数据（会话、配置、凭据、内置插件） | `%APPDATA%\Harness Desktop\dsh-home\` |
| 运行日志 | `%APPDATA%\Harness Desktop\logs\dsh-server.log` |

说明：

- 聊天记录、文件内容**默认只存本地**，不会上传到任何服务器；只有对话时才会把内容发送给你所配置的模型服务商；
- 桌面版使用**独立数据目录**，与官方 `~/.dsh` 完全隔离：互不读取、互不干扰，官方 `dsh web` 不会看到本应用的内置插件；
- 想与官方共享数据 / 更换目录：启动参数 `--dsh-home <路径>` 或环境变量 `DSH_DESKTOP_HOME`；
- 换电脑迁移数据：把 `dsh-home` 整个目录复制到新电脑的相同位置即可。

---

## 从源码构建

### 环境要求

- Windows 10/11 x64；
- [Node.js](https://nodejs.org) 20+（构建机需要，运行时可不需要）；
- npm 11+；
- 可访问 npm registry、nodejs.org、GitHub 的网络。

### 构建步骤

```powershell
git clone https://github.com/colm20060530/harness-desktop.git
cd harness-desktop

# 1. 安装构建依赖（Electron、electron-builder）
cd desktop
npm install

# 2. 准备运行时资源：下载 Node、安装 @deepseek-ai/dsh、下载内置插件
npm run prepare:resources

# 3a. 直接运行开发版（弹窗）
npm start

# 3b. 或打包安装版 + 便携版（产物在 desktop/dist/）
npm run pack
```

或使用仓库根目录的一键脚本：

```powershell
.\scripts\build.ps1
```

> 打包脚本已内置 Electron 国内镜像（npmmirror），网络环境不佳时更稳定；需要默认源可加 `-ElectronMirror ''`。

---

## 项目结构

```text
harness-desktop/
├── desktop/                    # 桌面应用源码
│   ├── main.js                 # Electron 主进程：起服务、装插件、开窗口、清理
│   ├── preload.js              # 渲染进程桥（沙箱隔离）
│   ├── splash.html             # 启动过渡页
│   ├── error.html              # 启动失败错误页
│   ├── package.json            # 应用与打包配置（含 allowScripts 授权）
│   ├── host-package.json       # 内置 dsh 运行时依赖清单
│   ├── resources/
│   │   └── aqua.patch.yml      # 内置插件注册覆盖层（源码）
│   ├── scripts/
│   │   ├── prepare-resources.ps1   # 准备 Node/dsh/插件运行时资源
│   │   └── make-icon.ps1           # 生成应用图标
│   └── build/icon.png          # 应用图标
├── scripts/build.ps1           # 一键构建脚本
├── release/                    # 最终发布产物（安装版 + 便携版）
├── docs/app-screenshot.png     # 界面截图
├── LICENSE                     # MIT 许可
└── README.md
```

> `harness/`、`plugin/` 等第三方源码克隆、`node_modules/`、构建中间产物均不保留在仓库中（可通过构建脚本自动获取/生成）。

---

## 工作原理

```text
Harness Desktop（Electron 主进程）
├─ 自愈安装内置插件
│    plugin → %APPDATA%\Harness Desktop\dsh-home\plugins
│              └─ junction → dsh-home\profiles\node_modules
├─ 启动内置 Node（resources\node\node.exe）
│    └─ node_modules\@deepseek-ai\dsh\lib\bin.js web
│         --patch resources\aqua.patch.yml   ← 插件注册覆盖层（每次启动必带）
│         --port 3080（占用则自动换空闲端口）
└─ BrowserWindow 加载 http://127.0.0.1:<port>
```

关键设计：

- **插件通过 `--patch` 覆盖层注入**，不写入用户自己的 `cordis.patch.yml`，官方 dsh 启动时完全不受影响；
- **每次启动自愈**：插件目录按内置版本比对刷新、模块链接被删即重建，因此「卸载」无法持久；
- **内置 Node 运行时**，用户机器无需预装任何环境。

---

## 常见问题 FAQ

**Q1：安装/运行时出现 SmartScreen 警告？**

软件暂未做代码签名。请从可信渠道获取安装包，然后点击「更多信息 → 仍要运行」即可，仅首次提示。

**Q2：提示端口被占用？**

不会失败。应用优先使用 3080 端口，被占用时自动选择空闲端口，无需手工处理。

**Q3：重复打开出现多个窗口？**

不会。应用有单实例锁，重复启动会聚焦已有窗口。

**Q4：配置了 API Key 还是无法对话？**

检查：Key 是否有效/有余额、网络能否访问服务商、Base URL 与模型名是否与服务商文档一致。`401` 多为密钥无效，`400` 多为参数或模型名问题。

**Q5：Aqua 插件能不能卸载？**

不能，也不需要。它是本应用的内置特性：没有卸载入口，即使手动删除文件，下次启动也会自动恢复。设置 → 插件 → Glass theme 的开关只控制主题显隐。

**Q6：和官方 `dsh web` 会冲突吗？**

不会。桌面版使用独立数据目录，官方 `~/.dsh` 与官方 Web UI 完全保持原样。

**Q7：会话记录在哪？能带走吗？**

在 `%APPDATA%\Harness Desktop\dsh-home\sessions\`。换电脑时整体复制 `dsh-home` 目录即可。

**Q8：为什么不用官方 Web UI 而要这个桌面版？**

桌面版 = 官方完整引擎 + 桌面窗口体验 + 内置 Aqua 玻璃拟态 UI。如果你只想要原版界面，直接用官方 `npx @deepseek-ai/dsh web` 即可；想要"官方体验 + 特色皮肤 + 免环境安装"，用本应用。

---

## 许可证与致谢

- 本项目（桌面壳代码、构建脚本、文档）：[MIT](LICENSE)
- 核心引擎：[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT，官方开源）
- 内置主题：[DSH-Transparent-UI-Plugin / @deepseek-ai/dsh-client-ui-aqua](https://github.com/WYH66666666/DSH-Transparent-UI-Plugin)（MIT）
- 桌面框架：[Electron](https://www.electronjs.org)（MIT）

感谢以上开源项目的作者们。

---

## 版本发布

### v1.0.0（2026-08-17）

- 基于官方 `@deepseek-ai/dsh@0.1.0-rc.6` 运行时封装；
- 内置 Aqua 玻璃拟态主题 v1.3.0（默认开启、不可卸载）；
- 内置 Node.js 24 运行时，免环境安装；
- 独立数据目录、插件自愈、单实例、关闭即清理；
- 产物：安装版 + 便携版（约 165 MB / 个）。

> 📌 **发布到 GitHub 的说明**：安装包约 165 MB，超过 GitHub 仓库 100 MB 的单文件限制，无法直接提交入库。因此发布流程是：代码推送到仓库，两个 exe 作为附件上传到 **Releases** 页面（已用仓库内的 `scripts/publish.ps1` 自动化）。当前 v1.0.0 已发布：[https://github.com/colm20060530/harness-desktop/releases/tag/v1.0.0](https://github.com/colm20060530/harness-desktop/releases/tag/v1.0.0)。
