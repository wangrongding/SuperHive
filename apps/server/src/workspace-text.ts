import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HiveError } from "./database.js";

/**
 * 工作区文件的文本解码（预览、diff 共用一套规则，保证新旧两侧一致）：
 * - 带 BOM 的按 UTF-8 / UTF-16LE / UTF-16BE 解码（UTF-16 里本来就有 NUL，所以先看 BOM 再判二进制）；
 * - 没有 BOM：前 8000 字节里有 NUL 算二进制；否则先严格按 UTF-8，失败退回 GB18030（GBK 的超集）；
 * - GB18030 解出来仍有大量替换字符的，也算二进制。
 * 非 UTF-8 的结果带上 encoding，网页据此标「GBK」「UTF-16」。
 */

export type TextEncodingLabel = "gbk" | "utf-16";

export type DecodedText = { text: string; encoding?: TextEncodingLabel };

/** 替换字符超过这个比例就不当文本（GB18030 几乎能解任何字节，只有乱数据才会大量解不出） */
const MAX_REPLACEMENT_RATIO = 0.01;

let gb18030: TextDecoder | null | undefined;
function gb18030Decoder(): TextDecoder | null {
  if (gb18030 === undefined) {
    try {
      gb18030 = new TextDecoder("gb18030");
    } catch {
      // 没带完整 ICU 的 Node：没法按 GBK 解，退回 UTF-8 宽松解码
      gb18030 = null;
    }
  }
  return gb18030;
}

/**
 * 解码一段文件内容；二进制返回 null。
 * partial：只读了文件开头（截在多字节字符中间时丢掉最后半个字符，不当成解码失败）。
 */
export function decodeText(
  data: Uint8Array,
  options: { partial?: boolean } = {},
): DecodedText | null {
  const stream = Boolean(options.partial);
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf)
    return { text: new TextDecoder("utf-8").decode(data, { stream }) };
  if (data[0] === 0xff && data[1] === 0xfe)
    return { text: new TextDecoder("utf-16le").decode(data, { stream }), encoding: "utf-16" };
  if (data[0] === 0xfe && data[1] === 0xff)
    return { text: new TextDecoder("utf-16be").decode(data, { stream }), encoding: "utf-16" };
  if (data.subarray(0, 8000).includes(0)) return null;
  const text = decodeLoose(data, stream);
  if (text.encoding && tooManyReplacements(text.text)) return null;
  return text;
}

/** git diff 的输出：同一份 diff 里新旧两侧、上下文行用同一种编码；文件头里的路径本来就是 UTF-8、不影响 hunk */
export function decodeDiff(data: Uint8Array): DecodedText {
  return decodeLoose(data, false);
}

function decodeLoose(data: Uint8Array, stream: boolean): DecodedText {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data, { stream }) };
  } catch {
    const decoder = gb18030Decoder();
    if (!decoder) return { text: new TextDecoder("utf-8").decode(data, { stream }) };
    // 共用的解码器：stream 解完要再 decode() 一次清掉残留状态
    const text = decoder.decode(data, { stream });
    if (stream) decoder.decode();
    return { text, encoding: "gbk" };
  }
}

function tooManyReplacements(text: string): boolean {
  let count = 0;
  for (let index = text.indexOf("�"); index >= 0; index = text.indexOf("�", index + 1)) count++;
  return count > Math.max(4, text.length * MAX_REPLACEMENT_RATIO);
}

type GitRunner = (args: string[]) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

/**
 * 两段已解码的文本按 UTF-8 写进临时目录，用 git diff --no-index 比，返回 git 的输出（UTF-8）。
 * 和工作区 diff 同一套算法、同样的格式；context 给整份上下文的行数。输出超限返回 null。
 */
export async function diffTexts(
  before: string,
  after: string,
  context: number | undefined,
  git: GitRunner,
): Promise<string | null> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "superhive-diff-"));
  try {
    const oldFile = path.join(directory, "old");
    const newFile = path.join(directory, "new");
    await Promise.all([writeFile(oldFile, before, "utf8"), writeFile(newFile, after, "utf8")]);
    let output: Awaited<ReturnType<GitRunner>>;
    try {
      output = await git([
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...(context ? [`--unified=${context}`] : []),
        "--",
        oldFile,
        newFile,
      ]);
    } catch (error) {
      if (error instanceof HiveError && error.code === "WORKSPACE_TOO_LARGE") return null;
      throw error;
    }
    // --no-index：0 没区别，1 有区别，别的是出错
    if (output.code !== 0 && output.code !== 1)
      throw new HiveError(
        "WORKSPACE_GIT_FAILED",
        output.stderr.trim().slice(0, 500) || `git exit ${output.code}`,
      );
    return output.stdout.toString("utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
