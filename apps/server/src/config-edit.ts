import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { parse as parseTomlDocument } from "smol-toml";
import { isAlias, isCollection, isNode, isScalar, parseDocument, visit, type YAMLMap } from "yaml";

/**
 * 按格式就地改配置文件里的一个字符串值：只动目标那一处，注释、顺序、缩进和其他键原样保留。
 * 认不出或改不安全的写法一律抛错（调用方当作「只读，请手动修改」），绝不整份重写。
 */

/* ---------- TOML：只按行处理需要的几项，其余原样保留（注释、顺序、格式都不动） ---------- */

const BARE_KEY = /^[A-Za-z0-9_-]+/;

/** 解析点分键（a.b."c.d"）；认不出时返回 undefined */
export function parseDottedKey(source: string): string[] | undefined {
  const parts: string[] = [];
  let rest = source.trim();
  for (;;) {
    let part: string | undefined;
    if (rest.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
      if (!match) return undefined;
      try {
        part = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return undefined;
      }
      rest = rest.slice(match[0].length);
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end < 0) return undefined;
      part = rest.slice(1, end);
      rest = rest.slice(end + 1);
    } else {
      const match = BARE_KEY.exec(rest);
      if (!match) return undefined;
      part = match[0];
      rest = rest.slice(match[0].length);
    }
    parts.push(part);
    rest = rest.trimStart();
    if (!rest) return parts;
    if (!rest.startsWith(".")) return undefined;
    rest = rest.slice(1).trimStart();
  }
}

export type TomlString = { value: string; end: number } | "complex";

/** 读一行里键后面的字符串值；多行字符串、数组、内联表等返回 complex */
function parseTomlString(source: string, start: number): TomlString {
  const rest = source.slice(start);
  if (rest.startsWith('"""') || rest.startsWith("'''")) return "complex";
  if (rest.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (!match) return "complex";
    try {
      return { value: JSON.parse(`"${match[1]}"`) as string, end: start + match[0].length };
    } catch {
      return "complex";
    }
  }
  if (rest.startsWith("'")) {
    const end = rest.indexOf("'", 1);
    if (end < 0) return "complex";
    return { value: rest.slice(1, end), end: start + end + 1 };
  }
  return "complex";
}

type TomlEntry = { line: number; value: TomlString; prefixEnd: number };
export type TomlTable = { header: number; end: number; entries: Map<string, TomlEntry> };

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
const KEY_LINE =
  /^(\s*)((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=\s*/;

/** 按表头分段；root 用空字符串。[[数组表]] 和认不出的表头不收，里面的键也不算 */
export function scanToml(content: string): Map<string, TomlTable> {
  const lines = content.split("\n");
  const tables = new Map<string, TomlTable>();
  let current: TomlTable | undefined = { header: -1, end: lines.length, entries: new Map() };
  tables.set("", current);
  let multiline: string | undefined;
  lines.forEach((line, index) => {
    if (multiline) {
      if (line.includes(multiline)) multiline = undefined;
      return;
    }
    if (/^\s*\[\[/.test(line)) {
      if (current) current.end = index;
      current = undefined;
      return;
    }
    const header = HEADER.exec(line);
    if (header) {
      if (current) current.end = index;
      const keys = parseDottedKey(header[1]!);
      current = keys ? { header: index, end: lines.length, entries: new Map() } : undefined;
      if (current && keys) tables.set(JSON.stringify(keys), current);
      return;
    }
    const key = KEY_LINE.exec(line);
    if (!key) return;
    const value = parseTomlString(line, key[0].length);
    const triple = /^("""|''')/.exec(line.slice(key[0].length))?.[1];
    if (triple && !line.slice(key[0].length + 3).includes(triple)) multiline = triple;
    const keys = parseDottedKey(key[2]!);
    if (current && keys) {
      current.entries.set(JSON.stringify(keys), { line: index, value, prefixEnd: key[0].length });
    }
  });
  return tables;
}

export function tomlKey(keys: string[]): string {
  return JSON.stringify(keys);
}

function tomlQuote(value: string): string {
  return JSON.stringify(value);
}

/** 把表 table 里的 key 设成字符串 value：已有就替换那一行的值（保留行尾注释），没有就加在小节末尾 */
export function setTomlString(
  content: string,
  table: string[],
  key: string,
  value: string,
): string {
  const tables = scanToml(content);
  const section = tables.get(table.length ? tomlKey(table) : "");
  if (!section) throw new Error("table not found");
  const lines = content.split("\n");
  const entry = section.entries.get(tomlKey([key]));
  if (entry) {
    if (entry.value === "complex") throw new Error("complex value");
    const line = lines[entry.line]!;
    lines[entry.line] =
      `${line.slice(0, entry.prefixEnd)}${tomlQuote(value)}${line.slice(entry.value.end)}`;
    return lines.join("\n");
  }
  // 插在小节最后一个非空行后面
  let at = section.end;
  while (at - 1 > section.header && !lines[at - 1]!.trim()) at -= 1;
  lines.splice(
    at,
    0,
    `${/^[A-Za-z0-9_-]+$/.test(key) ? key : tomlQuote(key)} = ${tomlQuote(value)}`,
  );
  return lines.join("\n");
}

export function tomlValue(
  tables: Map<string, TomlTable>,
  table: string[],
  key: string,
): TomlString | undefined {
  return tables.get(table.length ? tomlKey(table) : "")?.entries.get(tomlKey([key]))?.value;
}

/** 解析整份 TOML（读取和保存前校验用）；语法错误时返回 undefined */
export function parseToml(content: string): Record<string, unknown> | undefined {
  try {
    return parseTomlDocument(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export type TomlScalar = string | boolean | number | string[];

/** TOML 字面量：字符串用基本字符串（与 JSON 转义兼容），数组只收字符串 */
export function tomlLiteral(value: TomlScalar): string {
  if (Array.isArray(value)) return `[${value.map((item) => tomlQuote(item)).join(", ")}]`;
  if (typeof value === "string") return tomlQuote(value);
  return String(value);
}

const TOML_BARE_SCALAR =
  /^(true|false|[-+]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][-+]?[0-9_]+)?)(\s*(?:#.*)?)$/;

/** 改完核对：除了目标键，整份内容解析出来必须和原来一样 */
function checkToml(before: string, after: string, path: string[], value: TomlScalar | undefined) {
  const expected = parseToml(before);
  const actual = parseToml(after);
  if (!expected || !actual) throw new Error("invalid TOML");
  let target = expected;
  for (const part of path.slice(0, -1)) {
    const next = target[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) throw new Error("path");
    target = next as Record<string, unknown>;
  }
  if (value === undefined) delete target[path.at(-1)!];
  else target[path.at(-1)!] = value;
  if (JSON.stringify(sortKeys(actual)) !== JSON.stringify(sortKeys(expected))) {
    throw new Error("edit mismatch");
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}

/**
 * 把表 table 里的 key 设成 value（undefined 表示删掉这一行）：已有就只替换那一行的值、保留行尾注释，
 * 没有就加在小节末尾；表不存在时在文件末尾新建。只认单行的字符串、布尔、数字值，改完重新解析核对。
 */
export function setTomlValue(
  content: string,
  table: string[],
  key: string,
  value: TomlScalar | undefined,
): string {
  const tables = scanToml(content);
  const section = tables.get(table.length ? tomlKey(table) : "");
  const lines = content.split("\n");
  let next: string;
  const entry = section?.entries.get(tomlKey([key]));
  if (entry) {
    const line = lines[entry.line]!;
    let end: number;
    if (entry.value !== "complex") end = entry.value.end;
    else {
      const bare = TOML_BARE_SCALAR.exec(line.slice(entry.prefixEnd));
      if (!bare) throw new Error("complex value");
      end = entry.prefixEnd + bare[1]!.length;
    }
    if (value === undefined) lines.splice(entry.line, 1);
    else
      lines[entry.line] =
        `${line.slice(0, entry.prefixEnd)}${tomlLiteral(value)}${line.slice(end)}`;
    next = lines.join("\n");
  } else if (value === undefined) {
    return content;
  } else {
    const assignment = `${tomlBareKey(key)} = ${tomlLiteral(value)}`;
    if (section) {
      // 插在小节最后一个非空行后面
      let at = section.end;
      while (at - 1 > section.header && !lines[at - 1]!.trim()) at -= 1;
      lines.splice(at, 0, assignment);
      next = lines.join("\n");
    } else {
      const header = `[${table.map(tomlBareKey).join(".")}]`;
      const base = content.replace(/\n*$/, "");
      next = `${base}${base ? "\n\n" : ""}${header}\n${assignment}\n`;
    }
  }
  checkToml(content, next, [...table, key], value);
  return next;
}

export function tomlBareKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlQuote(key);
}

/**
 * 删掉表 prefix 及其所有子表（[prefix]、[prefix.env] …），其余内容原样保留；
 * 用内联写法（prefix = {...} 或 a.b = ...）定义的认不出，抛错由调用方当只读处理。
 */
export function removeTomlTable(content: string, prefix: string[]): string {
  const lines = content.split("\n");
  const keep: string[] = [];
  let dropping = false;
  let found = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^[\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const keys = parseDottedKey(header[1]!);
      dropping = Boolean(keys && prefix.every((part, index) => keys[index] === part));
      if (dropping) found = true;
    }
    if (!dropping) keep.push(line);
  }
  if (!found) throw new Error("table not found");
  const next = keep.join("\n").replace(/\n{3,}/g, "\n\n");
  const after = parseToml(next);
  const before = parseToml(content);
  if (!after || !before) throw new Error("invalid TOML");
  let target: Record<string, unknown> = before;
  for (const part of prefix.slice(0, -1)) target = target[part] as Record<string, unknown>;
  delete target[prefix.at(-1)!];
  // 删的是最后一个子表（例如唯一的 [mcp_servers.x]）时，隐式的父表 mcp_servers 也随之消失
  for (let depth = prefix.length - 1; depth > 0; depth--) {
    let parent: Record<string, unknown> = before;
    let child: Record<string, unknown> | undefined = after;
    for (const part of prefix.slice(0, depth - 1)) {
      parent = parent[part] as Record<string, unknown>;
      child = child?.[part] as Record<string, unknown> | undefined;
    }
    const key = prefix[depth - 1]!;
    const empty = Object.keys((parent[key] as Record<string, unknown>) ?? {}).length === 0;
    if (empty && !(child && key in child)) delete parent[key];
    else break;
  }
  if (JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(before))) {
    throw new Error("edit mismatch");
  }
  return next;
}

/** 在文件末尾追加一段 TOML（新建表用），追加后必须仍能解析 */
export function appendToml(content: string, text: string): string {
  const base = content.replace(/\n*$/, "");
  const next = `${base}${base ? "\n\n" : ""}${text.replace(/\n*$/, "")}\n`;
  if (!parseToml(next)) throw new Error("invalid TOML");
  return next;
}

/* ---------- JSON / JSONC：jsonc-parser 只改目标路径，注释和其余格式不动 ---------- */

export type JsonPath = Array<string | number>;

/** 解析 JSON / JSONC（允许注释和尾逗号）；有语法错误（例如 JSON5 的不带引号的键）时返回 undefined */
export function parseJsonc(content: string): unknown {
  if (!content.trim()) return {};
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  return errors.length ? undefined : value;
}

/** 原文件的缩进：用第一处缩进的空白，没有就两个空格 */
function indentOf(content: string): { insertSpaces: boolean; tabSize: number } {
  const indent = /\n([ \t]+)\S/.exec(content)?.[1];
  if (indent?.startsWith("\t")) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: indent?.length ?? 2 };
}

/** 把 path 处的值设成字符串 value；中间缺的对象会建出来 */
export function setJsoncString(content: string, path: JsonPath, value: string): string {
  return setJsoncValue(content, path, value);
}

/** 把 path 处设成任意 JSON 值；undefined 表示删掉这个键。改完再读一遍，目标处确实是新值才算 */
export function setJsoncValue(content: string, path: JsonPath, value: unknown): string {
  const base = content.trim() ? content : "{}\n";
  if (parseJsonc(base) === undefined) throw new Error("invalid JSON");
  const edits = modify(base, path, value, {
    formattingOptions: { ...indentOf(base), eol: "\n" },
  });
  const next = applyEdits(base, edits);
  let current: unknown = parseJsonc(next);
  for (const key of path) {
    current =
      typeof current === "object" && current !== null
        ? (current as Record<string | number, unknown>)[key]
        : undefined;
  }
  if (JSON.stringify(current) !== JSON.stringify(value)) throw new Error("edit not applied");
  return next;
}

/* ---------- YAML（omp 的 models.yml）：按节点的源码位置替换，改完重新解析核对 ---------- */

/** 有锚点、别名、显式标签或 flow 写法（{a: b}、[a]）的文档不改：按行改容易把引用关系改坏 */
export function yamlUnsafe(content: string): boolean {
  const document = parseDocument(content, { keepSourceTokens: true });
  if (document.errors.length) return true;
  let unsafe = false;
  visit(document, {
    Alias() {
      unsafe = true;
      return visit.BREAK;
    },
    Node(_, node) {
      if (node.anchor || node.tag || (isCollection(node) && node.flow)) {
        unsafe = true;
        return visit.BREAK;
      }
      return undefined;
    },
    Pair(_, pair) {
      // 合并键 <<:
      if (isScalar(pair.key) && pair.key.value === "<<") {
        unsafe = true;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  return unsafe;
}

export function parseYaml(content: string): unknown {
  const document = parseDocument(content);
  if (document.errors.length) return undefined;
  return document.toJS() ?? {};
}

/**
 * 把 path（全是映射键）处的值设成字符串 value：已有就替换那个标量的源码，
 * 没有就在它所在映射的最后一项后面加一行。改完重新解析，除这一处外内容必须完全一样。
 */
export function setYamlString(content: string, path: string[], value: string): string {
  if (yamlUnsafe(content)) throw new Error("unsafe YAML");
  const document = parseDocument(content);
  const quoted = JSON.stringify(value);
  const key = path.at(-1)!;
  const parent = path.length > 1 ? document.getIn(path.slice(0, -1), true) : document.contents;
  if (!isNode(parent) || isAlias(parent) || !("items" in parent)) throw new Error("no mapping");
  const map = parent as YAMLMap;
  const existing = map.get(key, true);
  let next: string;
  if (existing !== undefined) {
    if (!isScalar(existing) || !existing.range) throw new Error("not a scalar");
    // 块标量（| >）跨多行，替换容易改坏
    if (existing.type === "BLOCK_LITERAL" || existing.type === "BLOCK_FOLDED") {
      throw new Error("block scalar");
    }
    const [start, end] = existing.range;
    next = `${content.slice(0, start)}${quoted}${content.slice(end)}`;
  } else {
    const last = map.items.at(-1);
    const firstKey = map.items[0]?.key;
    if (!last || !isNode(firstKey) || !firstKey.range) throw new Error("empty mapping");
    const lineStart = content.lastIndexOf("\n", firstKey.range[0] - 1) + 1;
    const indent = content.slice(lineStart, firstKey.range[0]);
    if (indent.trim()) throw new Error("unexpected layout");
    const lastNode = isNode(last.value) ? last.value : last.key;
    const after = isNode(lastNode) && lastNode.range ? lastNode.range[1] : -1;
    if (after < 0) throw new Error("unexpected layout");
    const lineEnd = content[after - 1] === "\n" ? after - 1 : content.indexOf("\n", after);
    const line = `${indent}${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)}: ${quoted}`;
    next =
      lineEnd < 0
        ? `${content}\n${line}\n`
        : `${content.slice(0, lineEnd + 1)}${line}\n${content.slice(lineEnd + 1)}`;
  }
  const expected = parseYaml(content) as Record<string, unknown>;
  let target = expected;
  for (const part of path.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[key] = value;
  if (JSON.stringify(parseYaml(next)) !== JSON.stringify(expected))
    throw new Error("edit mismatch");
  return next;
}
