// node mkmail.mjs <sinter repo> <sinter-mail checkout> <out dir>: three apps of 12 pages (file: the newsletter through
// mail.parse; gen: a generated email of GEN (2000) elements as a file: tree; api: a body from an API, templates: true)
import { mkdirSync, writeFileSync, readdirSync, readFileSync, cpSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [REPO, PKG, OUT] = process.argv.slice(2).map((x) => realpathSync(resolve(x)) ?? x);
const RES = '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n';
const AGAIN = '<button id="again" data-sn-on-click="refresh(message)">again</button>';
const BENCHED = (use) => `${RES}<main data-sn-state="{ n: 0 }"><mail-body id="message" data-sn-with="{ ${use} }"></mail-body>${AGAIN}<button id="tick" data-sn-on-click="n++" data-sn-text="n"></button></main>`;
const BODIES = {
  file: `<sn-resource name="html" src="file:./emails/newsletter.txt" type="string"></sn-resource>
<main data-sn-let="{ body: mail.parse(html, { images: 'allow' }) }"><mail-body id="message" data-sn-with="{ body }"></mail-body></main>`,
  gen: `<sn-resource name="mail" src="file:./emails/gen.json" type="Body"></sn-resource>
<main><mail-body id="message" data-sn-with="{ body: mail }"></mail-body></main>`,
  api: BENCHED('body: n >= 0 ? message : null, templates: true'),
};
const page = (body, i) => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>t${i}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
const A = await import(join(PKG, 'test/app.ts'));
for (const [name, body] of Object.entries(BODIES)) {
  const root = join(OUT, name);
  rmSync(root, { recursive: true, force: true });
  const emails = join(root, 'emails');
  mkdirSync(emails, { recursive: true });
  for (const f of readdirSync(join(PKG, 'test/corpus'))) writeFileSync(join(emails, f.replace(/\.html$/, '.txt')), readFileSync(join(PKG, 'test/corpus', f)));
  writeFileSync(join(emails, 'gen.json'), JSON.stringify(A.newsletter(+(process.env.GEN ?? 2000))));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), "export * as mail from '@tiavision/sinter-mail';\n");
  writeFileSync(join(root, 'src/sinter.types.ts'), "export type { Body, Element } from '@tiavision/sinter-mail';\n");
  for (let i = 0; i < 12; i++) writeFileSync(join(root, `p${i}.html`), page(body, i));
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@tiavision'), { recursive: true });
  symlinkSync(PKG, join(root, 'node_modules/@tiavision/sinter-mail'), 'dir');
  symlinkSync(REPO, join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(REPO, 'node_modules/vite'), join(root, 'node_modules/vite'), 'dir');
  writeFileSync(join(root, 'vite.config.js'), `import { resolve } from 'node:path';\nimport { defineConfig } from 'vite';\nimport sinter from '@tiaforge-ui/sinter/vite';\nexport default defineConfig({ logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })], build: { rollupOptions: { input: Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['p' + i, resolve(import.meta.dirname, 'p' + i + '.html')])) } } });\n`);
}
