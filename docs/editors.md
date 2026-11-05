# Editor setup

`sinter lsp` is a language server for the HTML files of a sinter project. It runs from the project's
own `@tiaforge/sinter`, so the editor always matches the compiler the build uses.

| Feature | Needs |
| --- | --- |
| sinter's diagnostics as you type, in pages and partials | any TypeScript, or none |
| Type errors (`SN208`) as you type, hover types, completion in expressions, go to definition | TypeScript 7 in the project |
| Type errors on save | TypeScript 5 or 6 |
| Did-you-mean quick fix | any |

The server finds pages and plugin options (`openapi`, `types`, …) in the Vite config, like
`sinter check`. It writes generated files to `.sinter/`; add that to `.gitignore`.

## VS Code

Install the extension from `editors/vscode` (until it is on the Marketplace and Open VSX):

```sh
cd editors/vscode && npm install && npm run package
code --install-extension sinter-vscode-0.1.0.vsix
```

It starts `sinter lsp` for every HTML file under a folder with `node_modules/@tiaforge/sinter`, one
server per installation, and adds sinter's attributes and elements to HTML completion.
Settings: `sinter.server.path` (a CLI other than the project's), `sinter.trace.server`. Command:
`sinter: Restart language server`.

## Neovim (0.11+)

```lua
vim.lsp.config('sinter', {
  cmd = { 'npx', '--no-install', 'sinter', 'lsp', '--stdio' },
  filetypes = { 'html' },
  root_markers = { 'vite.config.ts', 'vite.config.js', 'package.json' },
})
vim.lsp.enable('sinter')
```

## Helix

In `languages.toml`, next to the HTML server Helix already uses:

```toml
[language-server.sinter]
command = "npx"
args = ["--no-install", "sinter", "lsp", "--stdio"]

[[language]]
name = "html"
language-servers = ["vscode-html-language-server", "sinter"]
```

## Emacs (Eglot)

```elisp
(add-to-list 'eglot-server-programs
             '((html-mode mhtml-mode) . ("npx" "--no-install" "sinter" "lsp" "--stdio")))
```

Eglot runs one server per buffer, so this replaces the HTML language server for these modes.

## Zed

Zed adds language servers only through extensions; there is no sinter extension for Zed yet.

## Other editors

Any LSP client works: run `npx sinter lsp --stdio` in the project root for `html` files. The server
supports full-text sync, published diagnostics, hover, completion (trigger `.`, with
resolve), definition, quick fixes, and `workspace/didChangeWatchedFiles` (it registers its own
watchers when the client allows dynamic registration).
