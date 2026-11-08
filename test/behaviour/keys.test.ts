import { afterEach, expect, test, vi } from 'vitest';
import { render } from '../../src/testing/index.js';

afterEach(() => { vi.unstubAllGlobals(); });

type Init = KeyboardEventInit & { type?: 'keydown' | 'keyup' };
/** dispatches a key event on `target`; returns whether its default was prevented */
function press(target: Element, key: string, init: Init = {}): boolean {
  const e = new KeyboardEvent(init.type ?? 'keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

const page = (attrs: string, inner = '') => `
  <main data-sn-state="{ log: [] }" ${attrs}>
    <p data-sn-text="log.join(' ')"></p>${inner}
  </main>`;

test('a filter runs only for its key; a match prevents the default, others do not', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-j="log.push('j')" data-sn-on-keydown-escape="log.push('esc')"`));
  const main = root.querySelector('main')!;
  expect(press(main, 'j')).toBe(true);
  expect(press(main, 'k')).toBe(false);
  expect(press(main, 'Escape')).toBe(true);
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('j esc');
});

test('letters: `n` is n, `shift-n` is N, whatever Caps Lock says', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-n="log.push('n')" data-sn-on-keydown-shift-n="log.push('N')"`));
  const main = root.querySelector('main')!;
  press(main, 'n');
  press(main, 'N', { shiftKey: true });
  press(main, 'N'); // Caps Lock on, no Shift
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('n N n');
});

test('characters: `question` matches ?, whichever keys typed it; Shift is not checked for it', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-question="log.push('?')" data-sn-on-keydown-slash="log.push('/')" data-sn-on-keydown-1="log.push('1')"`));
  const main = root.querySelector('main')!;
  press(main, '?', { shiftKey: true, code: 'Slash' });   // US
  press(main, '?', { shiftKey: true, code: 'Minus' });   // German
  press(main, '/', { code: 'Slash' });
  press(main, '1', { shiftKey: true, code: 'Digit1' });  // French
  press(main, '?', { ctrlKey: true });                   // other modifiers still count
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('? ? / 1');
});

test('named keys and modifiers match exactly: no extra Ctrl, Alt, Meta or Shift', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-j="log.push('j')" data-sn-on-keydown-ctrl-space="log.push('cs')" data-sn-on-keydown-shift-tab="log.push('st')"`));
  const main = root.querySelector('main')!;
  expect(press(main, 'j', { ctrlKey: true })).toBe(false);
  expect(press(main, 'j', { metaKey: true })).toBe(false);
  expect(press(main, 'j', { altKey: true })).toBe(false);
  press(main, ' ', { ctrlKey: true });
  press(main, ' ', { ctrlKey: true, shiftKey: true });
  press(main, ' ');
  press(main, 'Tab');
  press(main, 'Tab', { shiftKey: true });
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('cs st');
});

test('a non-Latin layout or a dead key falls back to the physical key for letters', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-ctrl-n="log.push('n')" data-sn-on-keydown-z="log.push('z')"`));
  const main = root.querySelector('main')!;
  press(main, 'т', { ctrlKey: true, code: 'KeyN' });    // Russian
  press(main, 'z', { code: 'KeyY' });                    // German: the key labelled Z
  press(main, 'y', { code: 'KeyZ' });                    // a Latin letter is never remapped
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('n z');
});

test('`mod` is Ctrl off Apple platforms', async () => {
  vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
  const { root, flush } = await render(page(`data-sn-on-keydown-mod-enter="log.push('send')"`));
  const main = root.querySelector('main')!;
  press(main, 'Enter', { metaKey: true });
  press(main, 'Enter', { ctrlKey: true });
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('send');
});

test('`mod` is Cmd (Meta) on Apple platforms', async () => {
  vi.stubGlobal('navigator', { platform: 'MacIntel' });
  const { root, flush } = await render(page(`data-sn-on-keydown-mod-enter="log.push('send')"`));
  const main = root.querySelector('main')!;
  press(main, 'Enter', { ctrlKey: true });
  press(main, 'Enter', { metaKey: true });
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('send');
});

test('keys typed into a field are the field\'s: an ancestor\'s filter skips them, the field\'s own runs', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-j="log.push('j')" data-sn-on-keydown-escape="log.push('esc')" data-sn-on-keydown-enter="log.push('enter')"`, `
    <input id="t"><textarea></textarea><select><option>a</option></select><div contenteditable="true"><b>x</b></div>
    <input id="own" data-sn-on-keydown-mod-enter="log.push('own')" data-sn-on-keydown-escape="log.push('own-esc')">
    <input type="checkbox"><button>b</button>`));
  const main = root.querySelector('main')!;
  for (const sel of ['#t', 'textarea', 'select', '[contenteditable]']) {
    expect(press(root.querySelector(sel)!, 'j')).toBe(false);
    expect(press(root.querySelector(sel)!, 'Escape')).toBe(false);
  }
  const own = root.querySelector('#own')!;
  press(own, 'Enter', { ctrlKey: true });
  press(own, 'Escape');
  press(own, 'j');                 // no filter of the field's matches, and the ancestor's skips a field
  // a checkbox or button keeps Enter and Space, not other keys
  press(root.querySelector('[type=checkbox]')!, 'Enter');
  press(root.querySelector('button')!, 'Enter');
  press(root.querySelector('button')!, 'j'); // runs: a button is not a field
  press(main, 'Enter');
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('own own-esc j enter');
});

test('the nearest element with a matching filter handles the key; one with no match passes it on', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown-j="log.push('outer j')" data-sn-on-keydown-escape="log.push('outer esc')"`, `
    <section tabindex="0" data-sn-on-keydown-escape="log.push('inner esc')"></section>`));
  const section = root.querySelector('section')!;
  press(section, 'j');
  press(section, 'Escape');
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('outer j inner esc');
});

test('a plain key handler that does not prevent the key passes it on: Caley\'s week grid inside a page with N and P', async () => {
  // the grid takes the arrow keys it uses from their default, and only those
  const { root, flush } = await render(page(`data-sn-on-keydown-shift-n="log.push('N')" data-sn-on-keydown-shift-p="log.push('P')"`, `
    <div class="week" tabindex="0" data-sn-on-keydown="($event.key === 'ArrowLeft' || $event.key === 'ArrowRight') && $event.preventDefault(); log.push('grid:' + $event.key)">
      <button>chip</button>
    </div>`));
  const chip = root.querySelector('button')!;
  expect(press(chip, 'N', { shiftKey: true })).toBe(true);   // not prevented by the grid: <main>'s filter runs
  expect(press(chip, 'ArrowLeft')).toBe(true);               // prevented by the grid: it stops there
  expect(press(chip, 'P', { shiftKey: true })).toBe(true);
  expect(press(chip, 'x')).toBe(false);                      // no filter matches further up
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('grid:N N grid:ArrowLeft grid:P P grid:x');
});

test('plain key handlers at two levels: the outer one sees the keys the inner one does not prevent', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown="log.push('outer:' + $event.key)"`, `
    <section tabindex="0" data-sn-on-keydown="$event.key === 'Enter' && $event.preventDefault(); log.push('inner:' + $event.key)"></section>`));
  const section = root.querySelector('section')!;
  press(section, 'Enter');
  press(section, 'a');
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('inner:Enter inner:a outer:a');
});

test('a debounced plain key handler, and a field\'s plain handler, keep their keys from ancestors\' filters', async () => {
  const { root, flush, advance } = await render(page(`data-sn-on-keydown-j="log.push('page j')"`, `
    <section tabindex="0" data-sn-debounce-keydown="50" data-sn-on-keydown="log.push('later:' + $event.key)"></section>
    <input data-sn-on-keydown="log.push('typed:' + $event.key)">`));
  press(root.querySelector('section')!, 'j');   // debounced: counts as handled, it will run
  press(root.querySelector('input')!, 'j');     // passed on, but the page's filter skips keys typed into a field
  await advance(50);
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('typed:j later:j');
});

test('filters and a plain handler on one element run in attribute order; the plain one for every key, without preventDefault', async () => {
  const { root, flush } = await render(page(`data-sn-on-keydown="log.push('any:' + $event.key)" data-sn-on-keydown-j="log.push('j')" data-sn-on-keydown-shift-j="log.push('J')"`));
  const main = root.querySelector('main')!;
  expect(press(main, 'j')).toBe(true);
  expect(press(main, 'k')).toBe(false);
  press(main, 'J', { shiftKey: true });
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('any:j j any:k any:J J');
});

test('keyup filters, repeats and IME composition', async () => {
  const { root, flush } = await render(page(`data-sn-on-keyup-escape="log.push('up')" data-sn-on-keydown-j="log.push('j')"`));
  const main = root.querySelector('main')!;
  press(main, 'Escape');
  expect(press(main, 'Escape', { type: 'keyup' })).toBe(true);
  press(main, 'j', { repeat: true });
  press(main, 'j', { isComposing: true });
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('up j');
});

test('$event is the KeyboardEvent; data-sn-debounce-<event> delays one filter', async () => {
  const { root, flush, advance } = await render(page(`data-sn-on-keydown-j="log.push($event.key)" data-sn-debounce-keydown-j="100" data-sn-on-keydown-k="log.push('k')"`));
  const main = root.querySelector('main')!;
  expect(press(main, 'j')).toBe(true);
  press(main, 'j');
  press(main, 'k');
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('k');
  await advance(100);
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('k j');
});

test('filters in a row template see the row', async () => {
  const { root, flush } = await render(`
    <main data-sn-state="{ picked: '' }"><p data-sn-text="picked"></p>
      <ul><template data-sn-for="x in ['a', 'b']" data-sn-key="x"><li tabindex="0" data-sn-on-keydown-enter="picked = x" data-sn-text="x"></li></template></ul>
    </main>`);
  press(root.querySelectorAll('li')[1]!, 'Enter');
  await flush();
  expect(root.querySelector('p')!.textContent).toBe('b');
});
