// The build's list of the pages that swap (`sinter({ swap: true })`, docs/proposals/swap-navigation.md §1):
// each page's path patterns (as next-page data matches them) and the names of the elements it keeps. A link
// swaps only to a URL that matches a page of the list; any other URL is the browser's, requested once.
// Pages with `<html data-sn-swap="off">` are not in it.

/** one page of the list: `m`, the paths it answers at; `k`, the names it keeps (`data-sn-permanent`) */
export interface SwapPage { m: string[]; k: string[] }

/** the virtual module the swap imports: the list as its default export */
export function swapModule(pages: SwapPage[]): string {
  return `export default ${JSON.stringify(pages.map((p) => (p.k.length ? { m: p.m, k: p.k } : { m: p.m })))};\n`;
}
