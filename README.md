# dsh-video-clone — 视频唯一化分发

[![CI](https://github.com/2015215218/dsh-video-clone/actions/workflows/ci.yml/badge.svg)](https://github.com/2015215218/dsh-video-clone/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

把**一支视频复制成 N 份，每份塞一个唯一 GUID，让文件哈希各不相同——画面内容一个字节都不变。**

适合多账号 / 多渠道 / 多设备分发同一素材时做唯一标识与事后溯源。

---

## 一句话原理

只改**容器**，不碰**码流**。

| 容器 | 写标记的位置 | 为什么合法 |
|---|---|---|
| MP4 / MOV | `moov/udta/meta/ilst/©cmt`（ffprobe 的 `comment`）+ 文件尾 `free` box | 注释是元数据；`free` 是规范定义的"请跳过"填充盒 |
| MKV / WebM | Segment 内 `Void` 元素 + `Tags/SimpleTag` | Void 是规范定义的填充元素；Tags 是元数据 |
| AVI / RIFF | 尾部 `JUNK` chunk + 原地修正 RIFF size | JUNK 是 RIFF 的标准填充 chunk |
| MPEG-TS / M2TS | 尾部 `null packet`（PID 0x1FFF） | 标准明确规定 null packet 的载荷"可以是任意值"，解复用器必须丢弃 |
| FLV | 尾部 script data tag，名字 `onXCLN` | 未知脚本标签会被播放器忽略，不覆盖真正的 `onMetaData` |
| 认不出 | 文件尾追加 | 原始字节仍是副本的完整前缀 |

改 MP4 时若需要让 `moov` 变长（把注释挤进去），会**同步修正 `stco`/`co64` 的绝对偏移**——这一步不做，文件能播但会花屏。

---

## 三重自证（每次运行都会跑，结果写进 ledger）

1. **字节布局**：按规划出的 splice 区间，把副本的"未触碰区间"与源文件逐一比对，并回读写入的数据确认一致 → `layoutOk`
2. **哈希互异**：N 份的 `sha256` / `md5` 两两不同，且都不等于源文件 → `hashesAllDistinct`
3. **媒体层**：用 `ffmpeg -f streamhash` 比编码流、`-f framemd5` 逐帧解码比像素 → `streamIdentical` / `framesIdentical`

任何一项不通过，`ok` 就是 `false`。

### 第 3 条有个必须守住的坑：校验器失效 ≠ 校验通过

`ffmpeg -f streamhash` / `-f framemd5` 拿不到输出时，最初返回的是**空串**。而调用方
拿"源的空串"和"副本的空串"比相等——**两个空串相等**，于是：

> 一个退出码 0、但什么都不输出的假 ffmpeg，能让 `streamIdentical` 全 `true`、
> `media.ok` 为 `true`、整体 `ok` 为 `true`，而每份的 `streamHash` 长度都是 0。

也就是**验证器压根没工作，报告却写着「媒体层 OK」**。这条是本工具最核心的承诺，
却能被静默误报——已实测复现。

现在的规则：**拿不到证据就响亮失败**。两个哈希函数在零输出时直接抛错，
`cloneVideo` 捕获后把 `media.ok` 落成 `false` 并把原因写进 `notes` 与 `media.error`
（副本已经写出来了，账本还有用，所以不炸掉整次克隆，但绝不留下"没验过却显示 OK"的状态）。
`test/run-tests.js` 的「校验器失效不许默认通过」小节用一个假的 ffmpeg 守着这条——
撤掉守卫会立刻挂 7 条断言。

同一次调用产出的 N 份，**文件体积完全一致**：写入的填充量按 `padBytes` 量化到 64 字节对齐，
不随标签的 UTF-8 字节数浮动（否则"抖音号A"=10B 与"快手F"=7B 会让同一支源的副本体积差几字节，分发时很扎眼）。

---

## 目录结构与装载要求

```
index.js            ← 宿主插件入口（导出 apply / inject / name / TOOL_NAMES），package.json 的 exports["."] 指向它
client.js           ← 客户端半边（DSH Web GUI 的面板），package.json 的 exports["./client"] 指向它
lib/index.js        ← 纯库入口（导出 cloneVideo / planMp4 / markerPayload 等函数）
lib/web.js          ← 面板用的 HTTP 路由（只搬运，不重新实现克隆逻辑）
lib/*.js            ← 各容器规划器与工具
bin/video-clone.js  ← CLI
```

**`package.json` 的 `exports["."]` 必须指向 `index.js`，不能指向 `lib/index.js`。**
宿主装载器按包名解析入口（`import('dsh-video-clone')`），拿到的模块必须带 `apply`；
指错到纯库入口时装载器拿不到 `apply`，插件会**静默不激活**（工具列表里什么都看不到、
宿主也不报错，只在该行 `fiberPhase` 显示 `null`）。`test/plugin-tests.js` 里有专门断言守这条。

**`index.js` 必须导出 `inject` 数组并含 `"tools"`。**
Cordis 要求插件先声明依赖才能访问 `ctx` 上的服务；不声明就 `ctx.tools.register(...)`
会在真实宿主里抛 `Error: cannot get property "tools" without inject`。
这个契约**只在真实 Cordis ctx 下强制**——用普通对象伪造 ctx 的测试测不出来，
所以测试里用了会抛错的 Proxy 来模拟。少了它宿主只会报一行 `failed`，很难定位。

### 装载与热更新

profile 里装的是**指向本仓库的软链**（`~/.dsh/profiles/desktop/node_modules/dsh-video-clone`
→ 本目录），所以改源码**不需要重新安装**。但：

**宿主进程会缓存已 import 的模块**，改完源码**必须重启 DSH** 才生效。
`plugin_manager` 的实时重载对已缓存的模块无效——实测会继续报**旧**错误、连行号都是旧的
（插一个独一无二的探针错误就能验证：宿主报的仍是旧错误，探针从未执行）。
定位这类问题别信"重载一下就好"，直接重启。

profile 的 `package.json` 里该插件声明为 `file:/…/dsh-video-clone` 依赖，
loader 顺着这条 `file:` 依赖解析到本目录（错误栈里出现的也是本目录路径）。

---

## 用法

### DSH 插件（已装进 desktop profile）

两个工具：

- `video_clone` —— 复制 N 份，每份一个 GUID
- `video_clone_scan` —— 在文件里找标记，反查是哪个 GUID / 哪一份

```
video_clone(input="素材.mp4", count=10, labels=["账号A","账号B",...], outputDir="分发")
```

常用参数：

| 参数 | 说明 |
|---|---|
| `count` | 份数，默认 5 |
| `mode` | `both`（默认，可见+隐形双保险）/ `pad`（只写解析器必跳过的填充）/ `meta`（只写可见元数据） |
| `labels` | 每份的标签（账号名/设备名），写进标记与账本 |
| `deriveFromLabel` | 用标签确定性推导 GUID —— 同一标签永远同一 GUID，账本丢了也能重算比对 |
| `namePattern` | 文件名模板，占位符 `{name} {i} {i:03} {guid} {label} {ext}` |
| `verify` | `frames`（默认，逐帧）/ `media`（编码流）/ `hash`（只算文件哈希）/ `off` |
| `strictSize` | 要求副本体积**与源完全一致**。只有源里存在可复用的 `free` box 或够大的注释字段才成立，否则直接报错、不做降级 |

### DSH Web 面板（GUI 工作台）

侧边栏会多一个「视频唯一化」图标（排在 SSH 下面），点开是一整块工作台：选源视频、
设份数/标签/策略/校验级别，点「开始生成」看进度条，结果直接列出每份的
标签、文件、大小、GUID、sha256，外加三项自证徽章；底部还有反查框，贴文件路径
就能读出里面写的 GUID。

**选源视频有两套方式**：

- **「选择文件…」** —— 弹**系统原生**的文件选择框。DSH 自带的只有目录选择器
  （`directoryPicker` / `uiWorkspace.pickDirectory`），没有文件选择器，所以这里直接调
  宿主所在系统的对话框程序：macOS `osascript … choose file`、Windows
  PowerShell `OpenFileDialog`（带 `-STA`，不然 WinForms 对话框起不来）、
  Linux `zenity --file-selection`。按扩展名过滤，起始目录默认落在当前源文件旁边。
- **「浏览目录」** —— 在面板内列目录，能顺带看到每个文件的大小，适合快速比对。

原生对话框和克隆一样是**两段式**：`pickFile` 立刻返回 `pickId`，对话框在宿主那边
后台开着，面板轮询 `pickPoll`。这样用户可以在对话框前停几分钟，也不会把 HTTP 请求
挂死；超时 5 分钟自动关闭，点「取消」安静退回、不报错。

**面板状态会记住**。面板是 slot 组件，一换到别的侧边栏条目 React 就把它卸载；
最初所有字段都是裸 `useState`，切走再回来源路径、份数、标签、上一轮结果全没了。
现在表单与上次结果都落 `localStorage`（`useStored`），回来还是你离开时的样子。

**「将输出到 …」是真的**。输出目录留空时，面板会显示宿主实际会用的那条路径；
算法与宿主 `cloneVideo` 的默认规则逐字对齐，测试里拿一次真跑的落盘位置做交叉验证。

其他几处按截图改的：反查卡片不再占用流程编号（原来没跑过时会出现 2 → 4 跳号）；
预估结果从按钮旁边一行小字改成了独立卡片（带容器/策略/体积差徽章）；
底部整段原理说明折成可展开的「▸ 原理与边界」；内容区最大宽度 1040 → 1320。

`pickFile` 支持 `dryRun: true`：只回报「将要执行什么命令」而不起进程。有了它，
测试才能走完整条 HTTP 路径验证命令构造，又不往用户屏幕上弹窗。AppleScript 分支
另有 `osacompile`（**只编译不执行**）做真语法校验——脚本合法与否可以离线确证，
同样不弹窗。

它和工具、CLI 跑的是**同一份**克隆实现——面板只是把参数发过去、把结果画出来，
不存在第二套逻辑。

面板的三条硬约束（写错任何一条，界面都不会出现）：

| 约束 | 写错会怎样 |
|---|---|
| `exports["./client"]` 必须指向 `client.js` | 宿主扫不到客户端半边 |
| `package.json` 里要有 `dsh.client = { platform: "web" }` | 同上——宿主就是靠这个字段发现 web 半边的 |
| `main` 席位的 `key` 与 `sidebar.panellist` 行的 `id` **逐字相同** | 点图标选中一行，主区域空白 |

再加两条顺序/契约：

- **先注册 `main`，再注册 `sidebar.panellist`**。宿主会拒绝选中一张还没有页面的行。
- 客户端半边的 `inject` 数组同理要写全（本插件是 `['slots', 'layout']`）。少了
  `slots` 会在严格 ctx 下抛 `cannot get property "slots" without inject`。

客户端半边是**裸模块**，没有构建步骤：外层是
`window.__ModuleLoader__.load({ id, factory })` 的工厂包装，里面用
`require("react")` 拿 React、用 `React.createElement` 画界面（不写 JSX，免得要编译器）。
颜色全部走主题 token（`--dsw-alias-*`），亮/暗主题自动跟随。

宿主侧的路由挂在 `/video-clone/api`（`ctx.webServer` 前缀路由），
只接受 POST，过浏览器信任 fence（回环/可信域 + 非跨站 + Origin 同源）。
克隆是长任务，所以 `clone` 立刻返回 `jobId`，面板轮询 `job` 取进度——
不让一个可能跑几分钟的请求挂在 HTTP 上。**刻意不把 `webServer` 写进模块级
`inject`**：它只存在于 web 部署，写进去会让插件在纯对话场景整个装不上；
改用 `ctx.inject(['webServer'], …)` 做可选依赖，服务缺席时两个工具照常可用。

### CLI

```bash
# 复制 10 份，按账号打标签，逐帧校验
node bin/video-clone.js clone 素材.mp4 -n 10 -l 账号A,账号B,账号C --verify frames

# 看某个文件里有没有标记、是哪个 GUID
node bin/video-clone.js scan 分发/*.mp4

# 干跑：只输出规划（写哪里、体积变化多少），不落盘
node bin/video-clone.js plan 素材.mp4

# 看容器结构
node bin/video-clone.js info 素材.mp4
```

### 账本

每次运行会在输出目录生成：

- `ledger.json` —— 完整记录（源哈希、选项、每份的 guid/标签/哈希/校验结论）
- `ledger.jsonl` —— 每行一份，方便 `grep`
- `ledger.csv` —— 方便 Excel 打开

---

## 实测结果

`node test/run-tests.js`（138 项）+ `node test/plugin-tests.js`（73 项），**0 失败**。覆盖：

| 场景 | 结果 |
|---|---|
| MP4（moov 在尾）/ faststart（moov 在头，需修正 151 个 `stco`）/ MOV | 哈希互异 ✔ 流不变 ✔ 帧不变 ✔ |
| MKV / WebM、AVI、TS、M2TS（sync@4）、FLV、未知容器 | 同上 ✔ |
| 已有 `©cmt` 但容量不足 → 增长 moov 并修正偏移 | ✔ |
| 已有够大的注释字段 → 原地覆盖（**体积零变化**） | ✔ |
| 有预留 `free` box → 原地写入（**体积零变化**） | ✔ |
| 无可复用填充位 + `strictSize` | 明确报错，不做降级 ✔ |
| N=50 批量 | 50 份 sha256 全不同 ✔ |
| 源文件本身 | 运行前后大小/内容不变 ✔ |

真实素材（1280×720 H.264 + AAC，43.7 秒，9.3 MB）实测：6 份，21.6 秒（含逐帧校验），每份 `streamIdentical=true`、`framesIdentical=true`。

同一素材走**面板 API** 的端到端实测（真 HTTP、真 job 轮询）：5 份，17.6 秒，
阶段 `copy → stream → frames → done`，布局 ✔ 哈希互异 ✔ 媒体层 `frames` ✔，
5 份体积全为 9319557、sha256 去重后仍是 5、反查每份命中 2 个标记且 CRC 全部 OK，
源文件 sha256 前后一字未变。

---

## 边界（务必知道）

- **它不会影响平台的内容层查重。** 本工具只改容器元数据，画面与音轨的每一个采样点都没变。平台用感知哈希 / 视频签名比对内容时，这些副本仍然是"同一支视频"。做唯一标识、溯源、防呆可以；指望靠它过内容查重不行。
- **`meta` 模式写的注释可以被剥离。** 转码、平台二次处理、`-map_metadata -1` 都会清掉可见元数据；但尾部 `free` / `Void` / `null packet` 这类填充因为动到它就等于动文件结构，反而更耐操。所以默认 `both`：两处都写，剥掉一处仍能溯源。
- **`©cmt` 不是隐写。** 它是明文 ASCII，`ffprobe` 直接读得到。要"看不出来"请用 `mode=pad`。
- **不重新编码。** 本工具不做转码、不加片头片尾、不换 BGM —— 那些会改画面，与本工具的承诺正好相反。
- **分片 MP4（fMP4 / DASH）** 不重排 `moov`，自动降级为尾部追加。
- 需要 `ffmpeg` 才能做媒体层校验；没有 `ffmpeg` 时自动降级为哈希校验，不会失败。

---

## 目录

```
index.js                  DSH 插件入口（注册 video_clone / video_clone_scan + 挂 web 路由）
client.js                 DSH Web 面板（裸模块，无构建步骤）
cordis.patch.yml          bundle patch：把插件行插进 profile roster
bin/video-clone.js        CLI（clone / scan / plan / info）
lib/web.js                面板的 HTTP 路由 + 任务表 + 浏览器信任 fence
lib/clone.js              编排核心 + ledger + 三重自证
lib/plan.js               容器探测与规划调度
lib/mp4.js  mkv.js  riff.js  mpegts.js  flv.js  generic.js   各容器规划器
lib/io.js                 随机读 / splice 流式改写 / 区间哈希
lib/marker.js             标记编解码 + CRC32 + 确定性 GUID
lib/verify.js             ffmpeg streamhash / framemd5 封装
lib/bytes.js              BMFF box 与 EBML VINT 原语
test/run-tests.js         端到端测试（自动造素材，离线可跑）
test/plugin-tests.js      插件装载与工具执行测试
test/web-tests.js         面板测试：真 HTTP + 真 Cordis 装载 + 客户端半边契约
```

零第三方依赖，只用 Node 内建 + `ffmpeg`。

---

## 安装到别的 profile

从本地源码装（开发时改完刷新即可生效）：

```bash
cd ~/.dsh/profiles/<profile>
pnpm add file:/path/to/dsh-video-clone
```

或直接从 Git 装：

```bash
pnpm add github:<你的账号>/dsh-video-clone
```

装完再把 `"dsh-video-clone"` 追加进该 profile `package.json` 的 `dsh.profile.bundles`。
宿主侧通过 `$DSH_HOME/profiles/node_modules` 这个 module fallback 目录解析
`@deepseek-ai/dsh-tools`，所以插件不需要自带 `node_modules`。

---

## 测试

```bash
npm test          # 三套：核心库 179 + 插件装载 86 + web/面板 126
```

- **核心库**（`test/run-tests.js`）只用 Node 内建 + `ffmpeg`，自带素材生成，离线可跑。
- **web/面板**（`test/web-tests.js`）起真 `node:http` 服务、发真 `fetch`、跑真 ffmpeg。
  其中「真 Cordis 装载」「主题 token 真实性」两组需要机器上装了 DSH；**没装会显式跳过并说明**，
  不会假装通过。`DSH_CORDIS_PATH=…` 可手动指定。
- **插件装载**（`test/plugin-tests.js`）必须有 DSH 安装才能解析 `@deepseek-ai/dsh-tools`。
  没有就打印跳过原因并 **exit 0**；想让缺 DSH 直接算失败，设 `REQUIRE_DSH=1`。

> 为什么要这么大费周章地区分「跳过」和「通过」：本项目栽过一次 —— 媒体层校验器在零输出时
> 返回空串，两个空串比相等，于是「什么都没验」被报成了「验过了」。参见下面「校验器失效 ≠ 校验通过」。

Node 18 / 20 / 22 / 24 均已实测全绿（CI 也跑这四个版本）。
