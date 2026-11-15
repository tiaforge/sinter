import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translate, renameRunes, renameDataExports } from './translate.mjs';

const t = (s) => translate(s, { filename: 'x.qz' });

test('if / elif / else', () => {
  assert.equal(t('[[if a]]A[[elif b > 1]]B[[else]]C[[end]]'), '{#if a}A{:else if b > 1}B{:else}C{/if}');
});

test('for with index, key and else; word order changes', () => {
  assert.equal(t('[[for item, i in items by item.id]]<li>{item.name}</li>[[else]]none[[end]]'),
    '{#each items as item, i (item.id)}<li>{item.name}</li>{:else}none{/each}');
  assert.equal(t('[[for x in list]]{x}[[end]]'), '{#each list as x}{x}{/each}');
  assert.equal(t('[[for { id, name } in rows.filter((r) => r.by) by id]]{name}[[end]]'),
    '{#each rows.filter((r) => r.by) as { id, name } (id)}{name}{/each}');
  assert.equal(t('[[for [k, v] in Object.entries(o) by k]]{k}[[end]]'), '{#each Object.entries(o) as [k, v] (k)}{k}{/each}');
  assert.equal(t('[[for x in a.by by x]]{x}[[end]]'), '{#each a.by as x (x)}{x}{/each}');
});

test('wait / done / failed', () => {
  assert.equal(t('[[wait p]]…[[done v]]{v}[[failed e]]{e.message}[[end]]'), '{#await p}…{:then v}{v}{:catch e}{e.message}{/await}');
});

test('raw, let, part, show', () => {
  assert.equal(t('[[raw html]]'), '{@html html}');
  assert.equal(t('[[for x in xs]][[let y = x * 2]]{y}[[end]]'), '{#each xs as x}{@const y = x * 2}{y}{/each}');
  assert.equal(t('[[part row(a)]]<b>{a}</b>[[end]][[show row(1)]]'), '{#snippet row(a)}<b>{a}</b>{/snippet}{@render row(1)}');
});

test('nested blocks: each [[end]] closes the innermost block', () => {
  const src = '[[if a]][[for x in xs by x.id]][[if x.ok]]ok[[else]]no[[end]][[wait x.p]][[done v]]{v}[[end]][[end]][[else]]empty[[end]]';
  assert.equal(t(src), '{#if a}{#each xs as x (x.id)}{#if x.ok}ok{:else}no{/if}{#await x.p}{:then v}{v}{/await}{/each}{:else}empty{/if}');
});

test('brackets and strings inside block expressions', () => {
  assert.equal(t('[[if a[b[0]] === "]]"]]y[[end]]'), '{#if a[b[0]] === "]]"}y{/if}');
  assert.equal(t("[[if s.startsWith('[[end]]')]]y[[end]]"), "{#if s.startsWith('[[end]]')}y{/if}");
  assert.equal(t('[[if `${a ? "]]" : x}` /* ]] */]]y[[end]]'), '{#if `${a ? "]]" : x}` /* ]] */}y{/if}');
});

test('strings containing [[ are not blocks', () => {
  assert.equal(t('<p title="[[if a]]">{"[[end]]"}</p>'), '<p title="[[if a]]">{"[[end]]"}</p>');
  assert.equal(t(`<p>{'[[for x in y]]'}</p>`), `<p>{'[[for x in y]]'}</p>`);
  assert.equal(t('<!-- [[if a]] -->ok'), '<!-- [[if a]] -->ok');
  assert.equal(t('<script>const s = "[[if a]]";</script>'), '<script>const s = "[[if a]]";</script>');
  assert.equal(t('<style>a[href]::after{content:"[[x]]"}</style>'), '<style>a[href]::after{content:"[[x]]"}</style>');
});

test('directives', () => {
  assert.equal(t('<input sync:value={q} toggle:active={on} with:focus onclick={() => go("sync:x")}>'),
    '<input bind:value={q} class:active={on} use:focus onclick={() => go("sync:x")}>');
  assert.equal(t('<div anim:fade enter:fly={{ y: 2 }} leave:fade css:color="red" title="toggle:x"></div>'),
    '<div transition:fade in:fly={{ y: 2 }} out:fade style:color="red" title="toggle:x"></div>');
  assert.equal(t('<a href=with:x>y</a>'), '<a href=with:x>y</a>');
});

test('runes in script, call position only', () => {
  const src = `<script>
  let { data, value = $twoway() } = $inputs();
  let n = $cell(0), big = $from(n > 10), list = $from.by(() => [n]);
  let cell = 1; const o = { $cell: 1 }; o.$cell(2);
  $watch(() => { $peek(n); }); $watch.pre(() => {});
  const s = "$cell(1)", c = '$from(x)', tpl = \`$watch(\${ $cell(1) })\`; // $cell(2)
  /* $inputs() */ const r = /\\$cell\\(/g;
</script>
<p>{"$cell(0)"}</p>`;
  const out = t(src);
  assert.match(out, /let \{ data, value = \$bindable\(\) \} = \$props\(\);/);
  assert.match(out, /let n = \$state\(0\), big = \$derived\(n > 10\), list = \$derived\.by\(/);
  assert.match(out, /let cell = 1; const o = \{ \$cell: 1 \}; o\.\$cell\(2\);/);
  assert.match(out, /\$effect\(\(\) => \{ \$inspect\(n\); \}\); \$effect\.pre/);
  assert.match(out, /const s = "\$cell\(1\)", c = '\$from\(x\)', tpl = `\$watch\(\$\{ \$state\(1\) \}\)`; \/\/ \$cell\(2\)/);
  assert.match(out, /\/\* \$inputs\(\) \*\/ const r = \/\\\$cell\\\(\/g;/);
  assert.match(out, /<p>\{"\$cell\(0\)"\}<\/p>/);
});

test('TypeScript generics and script attributes', () => {
  assert.equal(renameRunes('let a = $cell<number[]>([]);'), 'let a = $state<number[]>([]);');
  assert.equal(t('<script lang="ts" module>let a = $cell(1)</script>'), '<script lang="ts" module>let a = $state(1)</script>');
});

test('data exports', () => {
  assert.equal(renameDataExports('export async function fetchData({ fetch }) { const fetchData = 1; }'),
    'export async function load({ fetch }) { const fetchData = 1; }');
  assert.equal(renameDataExports('export const fetchData = () => {}; export const handlers = {};'), 'export const load = () => {}; export const actions = {};');
  assert.equal(renameDataExports('// export function fetchData\nexport function other() {}'), '// export function fetchData\nexport function other() {}');
});

test('errors name the file and position', () => {
  assert.throws(() => t('a\n[[if x]]b'), /x\.qz:2:1 \[\[if\]\] is never closed/);
  assert.throws(() => t('[[end]]'), /\[\[end\]\] without an open block/);
  assert.throws(() => t('[[done v]]'), /\[\[done\]\] outside \[\[wait\]\]/);
  assert.throws(() => t('[[if a]]x[[else]]y[[elif b]]z[[end]]'), /\[\[elif\]\] after \[\[else\]\]/);
  assert.throws(() => t('[[loop x]]'), /unknown block \[\[loop\]\]/);
  assert.throws(() => t('[[if a'), /unclosed "\[\["/);
});
