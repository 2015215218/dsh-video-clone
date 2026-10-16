/**
 * dsh-video-clone 宿主插件。
 *
 * 挂载方式：cordis.patch.yml 里一行 `- id: video-clone / name: dsh-video-clone`。
 * 本模块在宿主进程里跑，注册两个工具：
 *   · video_clone       —— 把一支视频复制成 N 份，每份一个唯一 GUID
 *   · video_clone_scan  —— 在文件里找标记，反查是哪个 GUID / 哪一份
 *
 * 只依赖 @deepseek-ai/dsh-tools（宿主进程内解析，无需插件自带 node_modules）
 * 与 Node 内建能力，不引入第三方依赖。
 */

import { basename, resolve } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { cloneVideo, scanMarkers, previewPlan, TOOL_VERSION } from './lib/clone.js';
import { mountWebRoutes } from './lib/web.js';

/** Loader 身份。 */
const name = 'video-clone';

/**
 * 依赖声明。Cordis 要求插件**先声明 inject** 才能访问 ctx 上的服务；
 * 直接 `ctx.tools.register(...)` 而不声明会抛：
 *   Error: cannot get property "tools" without inject
 * 注意：这个契约只在真实 Cordis ctx 下强制，用普通对象伪造 ctx 测不出来，
 * 所以 test/plugin-tests.js 必须校验 inject 已导出且含 "tools"。
 */
const inject = ['tools'];

/** 本插件提供的工具名（供配置白名单用）。 */
const TOOL_NAMES = ['video_clone', 'video_clone_scan'];

function summarize(result) {
  const lines = [];
  lines.push(`源文件：${result.source.path}（${result.source.size} 字节）`);
  lines.push(`容器：${result.container}　策略：${result.copies[0]?.strategy ?? 'n/a'}　校验级别：${result.verifyLevel}`);
  lines.push(`输出目录：${result.outputDir}`);
  for (const c of result.copies) {
    lines.push(`  #${c.index} ${c.file}`);
    lines.push(`      guid=${c.guid}${c.label ? ` label=${c.label}` : ''} sha256=${c.sha256}`);
    lines.push(`      媒体流不变=${c.streamIdentical ?? 'n/a'} 解码帧不变=${c.framesIdentical ?? 'n/a'}`);
  }
  const v = result.verification;
  lines.push(`自证：字节布局=${v.layoutOk ? '通过' : '失败'}　哈希两两互异=${v.hashesAllDistinct ? '通过' : '失败'}　媒体层=${v.media.ok === null ? '未执行' : v.media.ok ? '通过' : '失败'}`);
  if (v.collisions.length > 0 || v.sourceOverlap.length > 0) {
    lines.push(`冲突：${JSON.stringify({ collisions: v.collisions, sourceOverlap: v.sourceOverlap })}`);
  }
  lines.push(`账本：${result.ledgerPath}`);
  return lines.join('\n');
}

/** 注册工具。 */
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'video_clone',
    description: [
      '把一支视频复制成 N 份，每份写入一个唯一 GUID，使每个文件的哈希互不相同，而画面与音轨一个字节都不改。',
      '做法是在容器层写标记：MP4 写进 moov/udta 的注释字段与尾部 free box，MKV 写 Void 元素与 Tags，AVI 写 JUNK chunk，TS 写 null packet，FLV 写 script tag；媒体数据区间永远不被触碰。',
      '每次都会自证三件事：① 除规划出的标记区间外副本与源逐字节相同；② N 份的 sha256/md5 两两不同；③ 用 ffmpeg streamhash / framemd5 证明编码流与解码帧与源完全一致。',
      '同时产出 ledger.json（guid → 文件 → 标签），事后拿到任何一份都能反查是谁发的。',
      '适用于多账号/多渠道分发同一素材时的唯一标识与溯源。它不改变画面内容，因此不会影响平台的内容层查重判定。',
    ].join(' '),
    parameters: {
      input: { type: 'string', required: true, description: '源视频的绝对路径或工作区相对路径。' },
      count: { type: 'integer', description: '复制份数，默认 5，上限 500。' },
      outputDir: { type: 'string', description: '输出目录；默认是 <源目录>/<源文件名>_clones。' },
      mode: { type: 'string', enum: ['pad', 'meta', 'both'], description: '标记写入策略：pad=只写解析器必跳过的隐形填充；meta=只写可见元数据（ffprobe comment / MKV Tags）；both=两者都写（默认，任一被剥离仍可溯源）。' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: '每份的标签（账号名/设备名/渠道名），会写进标记与账本，便于一一对应。数量少于份数时其余为 null。',
      },
      deriveFromLabel: { type: 'boolean', description: '用标签确定性推导 GUID（同一标签永远得到同一 GUID），便于账本丢失后重算比对。' },
      namePattern: { type: 'string', description: '文件名模板，占位符 {name} {i} {i:03} {guid} {label} {ext}。默认 "{name}_{i:03}{ext}"。' },
      guids: { type: 'array', items: { type: 'string' }, description: '显式指定每份的 32 位十六进制 GUID。' },
      padBytes: { type: 'integer', description: '填充标记的字节长度，默认 192。' },
      verify: { type: 'string', enum: ['off', 'hash', 'media', 'frames'], description: '校验级别：hash=只算文件哈希；media=额外比对编码流哈希；frames=再逐帧解码比对（默认，最慢但最硬）。' },
      strictSize: { type: 'boolean', description: '要求副本体积与源文件完全相同。只有源文件里存在可复用的 free box 或足够大的注释字段时才成立，否则直接报错，不做降级。' },
      overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 true。' },
      ffmpegPath: { type: 'string', description: 'ffmpeg 可执行文件路径，默认 "ffmpeg"。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          outputDir: { type: 'string', required: true },
          ledgerPath: { type: 'string', required: true },
          container: { type: 'string', required: true },
          source: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              size: { type: 'integer', required: true },
              sha256: { type: 'string', required: true },
              md5: { type: 'string', required: true },
            },
          },
          copies: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                file: { type: 'string', required: true },
                path: { type: 'string', required: true },
                guid: { type: 'string', required: true },
                label: { type: 'string' },
                marker: { type: 'string', required: true },
                strategy: { type: 'string', required: true },
                visibleInMetadata: { type: 'boolean', required: true },
                size: { type: 'integer', required: true },
                sha256: { type: 'string', required: true },
                md5: { type: 'string', required: true },
                mediaUntouched: { type: 'boolean' },
                streamIdentical: { type: 'boolean' },
                framesIdentical: { type: 'boolean' },
              },
            },
          },
          verification: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              layoutOk: { type: 'boolean', required: true },
              hashesAllDistinct: { type: 'boolean', required: true },
              mediaLevel: { type: 'string', required: true },
              mediaOk: { type: 'boolean' },
              collisions: { type: 'integer', required: true },
              notes: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd;
      const input = cwd && !args.input.startsWith('/') ? resolve(cwd, args.input) : resolve(args.input);
      const result = await cloneVideo({
        input,
        outputDir: args.outputDir ? (cwd && !args.outputDir.startsWith('/') ? resolve(cwd, args.outputDir) : resolve(args.outputDir)) : undefined,
        count: args.count,
        mode: args.mode,
        labels: args.labels,
        deriveFromLabel: args.deriveFromLabel,
        guids: args.guids,
        namePattern: args.namePattern,
        padBytes: args.padBytes,
        verify: args.verify,
        strictSize: args.strictSize,
        overwrite: args.overwrite,
        ffmpegPath: args.ffmpegPath,
      });
      return {
        ok: result.ok,
        summary: summarize(result),
        outputDir: result.outputDir,
        ledgerPath: result.ledgerPath,
        container: result.container,
        source: {
          path: result.source.path,
          size: result.source.size,
          sha256: result.source.sha256,
          md5: result.source.md5,
        },
        copies: result.copies.map((c) => ({
          index: c.index,
          file: c.file,
          path: c.path,
          guid: c.guid,
          ...(c.label ? { label: c.label } : {}),
          marker: c.marker,
          strategy: c.strategy,
          visibleInMetadata: c.visibleInMetadata,
          size: c.size,
          sha256: c.sha256,
          md5: c.md5,
          ...(c.mediaUntouched === null ? {} : { mediaUntouched: c.mediaUntouched }),
          ...(c.streamIdentical === null ? {} : { streamIdentical: c.streamIdentical }),
          ...(c.framesIdentical === null ? {} : { framesIdentical: c.framesIdentical }),
        })),
        verification: {
          layoutOk: result.verification.layoutOk,
          hashesAllDistinct: result.verification.hashesAllDistinct,
          mediaLevel: result.verification.media.level,
          ...(result.verification.media.ok === null ? {} : { mediaOk: result.verification.media.ok }),
          collisions: result.verification.collisions.length + result.verification.sourceOverlap.length,
          notes: result.verification.notes,
        },
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'video_clone_scan',
    description: [
      '在视频文件里查找本工具写入的 GUID 标记，用于反查某一份是谁发的。',
      '默认只扫文件头与尾部各 4MB（标记一定落在 moov/udta 或文件尾），--full 时整文件流式扫描。',
      '输出每个标记的偏移、GUID 与 CRC 自校验结果。',
    ].join(' '),
    parameters: {
      files: { type: 'array', required: true, items: { type: 'string' }, description: '要扫描的文件路径列表。' },
      full: { type: 'boolean', description: '整文件扫描，默认 false（只扫头尾）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                size: { type: 'integer', required: true },
                markers: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      offset: { type: 'integer', required: true },
                      guid: { type: 'string', required: true },
                      valid: { type: 'boolean', required: true },
                      marker: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd;
      const paths = args.files.map((f) => (cwd && !f.startsWith('/') ? resolve(cwd, f) : resolve(f)));
      const results = await scanMarkers(paths, { full: args.full });
      const summary = results.map((r) => {
        if (r.markers.length === 0) return `${basename(r.path)}（${r.size} 字节）：未找到标记`;
        return `${basename(r.path)}（${r.size} 字节）：\n${r.markers.map((m) => `  @${m.offset} guid=${m.guid} crc=${m.valid ? 'OK' : 'MISMATCH'}`).join('\n')}`;
      }).join('\n');
      return {
        files: results.map((r) => ({
          path: r.path,
          size: r.size,
          markers: r.markers.map((m) => ({ offset: m.offset, guid: m.guid, valid: m.valid, marker: m.marker })),
        })),
        summary: summary || '没有可扫描的文件',
      };
    },
  }));

  // GUI 面板的 HTTP 路由。刻意**不**写进模块级 inject：
  // webServer 只存在于 web 部署，写进去会让插件在纯对话场景整个装不上。
  // 用 ctx.inject 做可选依赖，服务缺席时这段直接不执行，两个工具照常可用。
  ctx.inject(['webServer'], (wctx) => {
    const dispose = mountWebRoutes(wctx);
    wctx.effect(() => dispose, 'video-clone: web routes');
  });
}

export { apply, inject, name, TOOL_NAMES, TOOL_VERSION };
