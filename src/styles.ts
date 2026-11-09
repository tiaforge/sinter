// The stylesheets a page loads, in order, for the cascade in compiler/layout.ts: its
// `<link rel="stylesheet">` and `<style>` elements, and the CSS its module scripts import (with
// the project modules they import, and sinter's own modules: config, helpers, actions).
// Each one is what the bundler makes of it (`StyleContext.compile`: in Vite, its `preprocessCSS`,
// so Sass, Less, Stylus, the project's PostCSS plugins and `@import` with its `layer()` and media
// are applied as in the build), not its source. Without `compile`, plain CSS only, with `@import`
// inlined here. Left out: remote stylesheets, CSS modules and `?inline`/`?url` imports (none of
// them style the markup as written).
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as parse5 from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { StyleSheet } from './compiler/layout.js';

type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

export interface StyleContext {
  root: string;
  publicDir: string | null;
  /** Vite's resolver: a module id as imported from `importer`, to a file */
  resolve(id: string, importer: string): Promise<string | null | undefined>;
  /** modules the page module imports (sinter's config, helpers, actions, early module) */
  modules: string[];
  /** a stylesheet as the bundler outputs it, with the files it read; null when it cannot be compiled */
  compile?: (code: string, file: string) => Promise<{ code: string; deps: string[] } | null>;
}

const SCRIPT = /\.[cm]?[jt]sx?$/;
const IMPORTS = /(?:^|[;\s])(?:import|export)\s*(?:[\w*{}\s,$]+from\s*)?['"]([^'"\n]+)['"]/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/g;
const REMOTE = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;

const texts = new Map<string, { mtime: number; text: string }>();
function read(file: string): string | null {
  try {
    const m = statSync(file).mtimeMs;
    const c = texts.get(file);
    if (c && c.mtime === m) return c.text;
    const text = readFileSync(file, 'utf8');
    texts.set(file, { mtime: m, text });
    return text;
  } catch {
    return null;
  }
}

const plainCss = (file: string) => /\.css$/i.test(file) && !/\.module\.css$/i.test(file);
const STYLE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)$/i;

/** compiled stylesheets, valid while the file and every file it read are unchanged */
const compiled = new Map<string, { stamps: Array<[string, number]>; code: string | null }>();
const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return -1; } };

export async function pageStyles(html: string, file: string, ctx: StyleContext): Promise<StyleSheet[]> {
  const sheets: StyleSheet[] = [];
  const isStyle = (f: string) => (ctx.compile ? STYLE.test(f) && !/\.module\.\w+$/i.test(f) : plainCss(f));
  const seenModules = new Set<string>();
  const seenCss = new Set<string>();
  const doc = parse5.parse(html);

  const addCss = async (path: string, media: string | null) => {
    if (seenCss.has(path)) return;
    seenCss.add(path);
    const css = ctx.compile ? await compileFile(path, ctx.compile) : await inline(path, ctx, new Set([path]));
    if (css !== null) sheets.push({ file: path, css: wrap(css, media) });
  };
  const scan = async (id: string, importer: string, code?: string) => {
    let target: string | null | undefined = code === undefined ? null : importer;
    if (code === undefined) {
      if (REMOTE.test(id) || id.includes('?')) return;
      target = await ctx.resolve(id, importer).catch(() => null);
      if (!target) return;
      target = target.replace(/[?#].*$/, '');
      if (isStyle(target)) return addCss(target, null);
      if (!SCRIPT.test(target) || target.includes('/node_modules/') || seenModules.has(target)) return;
      seenModules.add(target);
      code = read(target) ?? '';
    }
    const body = code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const m of body.matchAll(IMPORTS)) await scan(m[1]!, target!);
  };

  const elements: P5Element[] = [];
  const walk = (p: P5Parent) => {
    for (const c of p.childNodes) {
      if (!('tagName' in c)) continue;
      if (['link', 'style', 'script'].includes(c.tagName)) elements.push(c);
      walk(c.tagName === 'template' ? (c as DefaultTreeAdapterMap['template']).content : c);
    }
  };
  walk(doc);
  const attr = (el: P5Element, n: string) => el.attrs.find((a) => a.name === n)?.value;
  const local = (href: string, from: string): string | null => {
    if (REMOTE.test(href) || href.startsWith('data:')) return null;
    const path = href.replace(/[?#].*$/, '');
    if (!path.startsWith('/')) return resolve(dirname(from), path);
    const inRoot = resolve(ctx.root, '.' + path);
    if (read(inRoot) !== null || !ctx.publicDir) return inRoot;
    return resolve(ctx.publicDir, '.' + path);
  };
  for (const el of elements) {
    const media = attr(el, 'media')?.trim() || null;
    if (el.tagName === 'link' && /(^|\s)stylesheet(\s|$)/i.test(attr(el, 'rel') ?? '') && !/(^|\s)alternate(\s|$)/i.test(attr(el, 'rel') ?? '')) {
      const path = local(attr(el, 'href') ?? '', file);
      if (path && isStyle(path)) await addCss(path, media);
    } else if (el.tagName === 'style') {
      const text = el.childNodes.map((c) => ('value' in c ? (c as { value: string }).value : '')).join('');
      // compiled as a stylesheet next to the page, so its imports resolve from there
      const css = ctx.compile ? (await ctx.compile(text, `${file}.style.css`).catch(() => null))?.code ?? null : await inlineText(text, file, ctx, new Set());
      if (css !== null) sheets.push({ file, css: wrap(css, media) });
    } else if (el.tagName === 'script' && attr(el, 'type') === 'module') {
      const src = attr(el, 'src');
      if (src) { const path = local(src, file); if (path) await scan(path, file); }
      else await scan('', file, el.childNodes.map((c) => ('value' in c ? (c as { value: string }).value : '')).join(''));
    }
  }
  for (const m of ctx.modules) await scan(m, file);
  return sheets;
}

async function compileFile(path: string, compile: NonNullable<StyleContext['compile']>): Promise<string | null> {
  const c = compiled.get(path);
  if (c && c.stamps.every(([f, m]) => mtime(f) === m)) return c.code;
  const text = read(path);
  if (text === null) return null;
  const out = await compile(text, path).catch(() => null);
  const files = [path, ...(out?.deps ?? [])];
  compiled.set(path, { stamps: files.map((f) => [f, mtime(f)]), code: out?.code ?? null });
  return out?.code ?? null;
}

const wrap = (css: string, media: string | null) => (media && !/^(all|screen)$/i.test(media) ? `@media ${media} {\n${css}\n}` : css);

async function inline(path: string, ctx: StyleContext, chain: Set<string>): Promise<string | null> {
  const text = read(path);
  return text === null ? null : inlineText(text, path, ctx, chain);
}

/** `@import`s replaced by their files, inside `@layer` (for `layer`/`layer(x)`) and `@media` (for a query or `supports()`) */
async function inlineText(text: string, from: string, ctx: StyleContext, chain: Set<string>): Promise<string> {
  let out = '', last = 0;
  for (const m of text.matchAll(CSS_IMPORT)) {
    out += text.slice(last, m.index);
    last = m.index! + m[0].length;
    const [, , href, rest] = m;
    if (REMOTE.test(href!)) continue;
    // a URL relative to the stylesheet, else (a bare name) a package, as Vite resolves it
    const near = href!.startsWith('/') ? resolve(ctx.root, '.' + href) : resolve(dirname(from), href!);
    const path = read(near) !== null || href!.startsWith('/') || href!.startsWith('.') ? near : await ctx.resolve(href!, from).catch(() => null);
    if (!path || chain.has(path) || !plainCss(path.replace(/[?#].*$/, ''))) continue;
    let css = await inline(path.replace(/[?#].*$/, ''), ctx, new Set([...chain, path]));
    if (css === null) continue;
    let tail = rest!.trim();
    const layer = /^layer(?:\(\s*([^)]*)\))?/i.exec(tail);
    if (layer) { tail = tail.slice(layer[0].length).trim(); }
    // a media query or supports(): may or may not apply, which is all the cascade needs to know
    if (tail) css = `@media ${tail} {\n${css}\n}`;
    if (layer) css = `@layer${layer[1] ? ` ${layer[1].trim()}` : ''} {\n${css}\n}`;
    out += css;
  }
  return out + text.slice(last);
}
