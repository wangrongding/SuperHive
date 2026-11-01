import { useSyncExternalStore } from "react";
import en from "./en.json";

/**
 * 界面多语言：界面文案以中文原文作为 key（中文直接显示原文），其它语言在对应的 JSON 里按原文查译文；
 * 查不到时退回中文，不会显示空白或 key。占位符写作 {name}，由 t() 的第二个参数替换。
 */
/** 占位符的值；null / undefined 显示为空（与 JSX 不渲染它们一致） */
export type Params = Record<string, string | number | null | undefined>;

export type Locale = "zh-CN" | "en";
export type LocalePreference = "system" | Locale;

export const LOCALE_STORAGE_KEY = "superhive.locale";
export const LOCALE_OPTIONS: Array<{ value: LocalePreference; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "English" },
];

const catalogs: Record<Exclude<Locale, "zh-CN">, Record<string, string>> = { en };

export function systemLocale(languages: readonly string[] = navigatorLanguages()): Locale {
  // 测试按中文界面断言（jsdom 的系统语言是 en-US）
  if (import.meta.env?.MODE === "test" && languages === defaultLanguages) return "zh-CN";
  for (const language of languages) {
    const lower = language.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "zh-CN";
}

let defaultLanguages: readonly string[] = [];
function navigatorLanguages(): readonly string[] {
  defaultLanguages = navigatorLanguagesRaw();
  return defaultLanguages;
}

function navigatorLanguagesRaw(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function readPreference(): LocalePreference {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en" || stored === "system") return stored;
  } catch {
    // 无法访问 localStorage 时按系统语言
  }
  return "system";
}

let preference: LocalePreference = readPreference();
let current: Locale = preference === "system" ? systemLocale() : preference;
const listeners = new Set<() => void>();

function apply(): void {
  current = preference === "system" ? systemLocale() : preference;
  if (typeof document !== "undefined") document.documentElement.lang = current;
  for (const listener of listeners) listener();
}
if (typeof document !== "undefined") document.documentElement.lang = current;

export function getLocale(): Locale {
  return current;
}

export function getLocalePreference(): LocalePreference {
  return preference;
}

export function setLocalePreference(next: LocalePreference): void {
  preference = next;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    // 只在本次会话生效
  }
  apply();
}

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name] ?? "") : match,
  );
}

export function t(source: string, params?: Params): string {
  const translated = current === "zh-CN" ? source : (catalogs[current][source] ?? source);
  return interpolate(translated, params);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 在根组件调用：语言切换后整棵树重新渲染，t() 取到新语言 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/**
 * 模块顶层的文案表（选项列表、标签映射等）在导入时就求值，直接写 t() 会固定成首次加载时的语言。
 * 用 localized 包一层：每次读取按当前语言取对应版本（每种语言只构造一次）。
 */
export function localized<T extends object>(factory: () => T): T {
  const cache = new Map<Locale, T>();
  const valueFor = (): T => {
    let value = cache.get(current);
    if (!value) {
      value = factory();
      cache.set(current, value);
    }
    return value;
  };
  const initial = valueFor();
  return new Proxy(initial, {
    get: (_target, key) => {
      const value = valueFor();
      const result = Reflect.get(value, key, value) as unknown;
      return typeof result === "function"
        ? (result as (...a: unknown[]) => unknown).bind(value)
        : result;
    },
    has: (_target, key) => Reflect.has(valueFor(), key),
    ownKeys: () => Reflect.ownKeys(valueFor()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(valueFor(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
