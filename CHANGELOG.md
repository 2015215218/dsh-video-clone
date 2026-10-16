# 更新日志

本文件记录 dsh-video-clone 的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 什么算「破坏性」

本插件的对外契约不是「源码没变」，而是下面这几样。**动到其中任何一个就要发 major**：

| 契约 | 具体指 |
|---|---|
| DSH 工具 | `video_clone` / `video_clone_scan` 的**名称**与**输入字段** |
| 面板 API | `/video-clone/api` 下各 action 的名字与请求/响应字段 |
| 账本格式 | `ledger.json` / `.jsonl` / `.csv` 的字段名与语义 |
| 清单字段 | `package.json` 里的 `dsh.bundle.patch`、`dsh.client`、`exports["./client"]` |
| CLI | 子命令名与参数语义 |

- **minor** = 新增能力且向后兼容（新容器、新选项、新面板功能）
- **patch** = 修 bug、文档、内部重构

版本号的唯一事实源是 `package.json` 的 `version`（`TOOL_VERSION` 由它推导，见 `lib/clone.js`）。
发版请走 `npm run release`，不要手改版本号。

---

## [Unreleased]

## [1.0.0] - 2026-10-16

首个公开发布。

### Added

- **容器层唯一标记**，覆盖五类容器；认不出的容器退化为文件尾追加：
  - MP4 / MOV —— `moov/udta/meta/ilst/©cmt` 注释 + 文件尾 `free` box
  - MKV / WebM —— Segment 内 `Void` 元素 + `Tags/SimpleTag`
  - AVI / RIFF —— 尾部 `JUNK` chunk + 原地修正 RIFF size
  - MPEG-TS / M2TS —— 尾部 `null packet`（PID 0x1FFF）
  - FLV —— 尾部 script data tag，`onXCLN`
- 需要加长 `moov` 时**同步修正 `stco`/`co64` 的绝对偏移**（不做这步文件能播但会花屏）
- **三重自证**，每次运行都跑并写进账本：字节布局、哈希互异、媒体层（`ffmpeg -f streamhash` + `-f framemd5` 逐帧解码）
- **溯源账本**：`guid → 文件 → 标签`，同时产出 `ledger.json` / `.jsonl` / `.csv`，并记录工具名与版本
- **确定性 GUID**：`--derive-from-label` 让同一标签永远推导出同一 GUID，账本丢了也能重算比对
- **体积一致性**：`padBytes` 量化到 64 字节，标签长短不再让同一支源的副本体积参差
- **CLI**：`clone` / `scan` / `plan` / `info`，`--json` 可机读
- **DSH 插件（宿主半边）**：注册 `video_clone` / `video_clone_scan`；`webServer` 走 `ctx.inject` 可选依赖，纯对话部署也能装
- **DSH Web 面板**：侧边栏「视频唯一化」+ 主面板，含进度、结果表、三项自证、反查框
- **原生文件选择框**：macOS `osascript`、Windows PowerShell `OpenFileDialog`、Linux `zenity`
- 面板表单与结果落 localStorage —— 切走再切回不再清空
- **零第三方运行时依赖**，只用 Node 内建 + `ffmpeg`
- 测试 392 项，Node 18 / 20 / 22 / 24 全绿；GitHub Actions 跑四版本矩阵

### Fixed

（以下都在公开发布之前修掉，写在这里是因为它们值得单独记一笔）

- **媒体层校验的静默误报**：`ffmpegStreamHash` / `ffmpegFrameHashes` 在零输出时返回空串，而调用方拿两个空串比相等 —— 于是「什么都没验」被报成了「验过了」。传个退出码 0 却不输出的假 ffmpeg 即可复现。现在零输出直接抛错，`cloneVideo` 捕获后把 `media.ok` 落成 `false` 并把原因写进 `notes`。**副本已经写出来了、账本还有用，所以不炸掉整次克隆，但绝不留「没验过却显示 OK」的状态。**
- **为验一个 16 字节的 box 头部真分配 4 GB**：测试里 `box('free', Buffer.alloc(0xffffffff))` 会分配 4 GB，`concat` 时峰值 8 GB，且在 Node 18/20 上撞 `Buffer.MAX_LENGTH = 4 GiB` 直接崩掉整套测试。拆出 `boxHeader()`，把「该走 32 位还是 64 位 largesize」的判断与物化解耦。
- **面板主按钮在深色主题下白底白字**：`--dsw-alias-brand-primary` 是个会翻转的 token（深色主题下近白），配写死的 `#fff` 前景就看不见了。改用平台自带的对比色对 `--dsw-alias-button-contrast-fill` + `--dsw-alias-label-primary-inverted`。

### Notes

- **本工具只改容器元数据，不声称能对抗平台的内容层查重。** 画面与音轨每个采样点都没变，感知哈希照样判定为同一支视频。它的定位是**多账号分发时的唯一标识与事后溯源**。
- `meta` 类标记（如 MP4 的 `©cmt`）可能被转码或 `-map_metadata -1` 剥掉；尾部的 `free` / `Void` / `null packet` 填充更耐久，所以默认 `mode=both` 两处都写。

[Unreleased]: https://github.com/2015215218/dsh-video-clone/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/2015215218/dsh-video-clone/releases/tag/v1.0.0