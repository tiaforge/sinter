// An island: a custom element that does what sinter expressions cannot (here: draw on a canvas).
// Data comes in through properties, `data-sn-prop="{ tasks, show }"`, and goes out as DOM events,
// `data-sn-on-chart-select="show = $event.detail"`. sinter never touches the island's children.
import type { Task } from '../sinter.types';

const TAU = 2 * Math.PI;

/**
 * `<task-chart>`: a ring of done and open tasks. A click on a part dispatches a bubbling
 * `chart-select` CustomEvent: detail 'done' or 'open', or 'all' when that part is already shown.
 */
class TaskChart extends HTMLElement {
  #tasks: readonly Task[] = [];
  #show = 'all';
  #canvas = document.createElement('canvas');
  #probe = document.createElement('span'); // resolves temper's color tokens for the canvas
  #resize = new ResizeObserver(() => this.#draw());
  #scheme = matchMedia('(prefers-color-scheme: dark)');
  #redraw = () => this.#draw();

  get tasks() { return this.#tasks; }
  set tasks(value: readonly Task[]) {
    this.#tasks = value ?? [];
    this.#draw();
  }

  get show() { return this.#show; }
  set show(value: string) {
    this.#show = value;
    this.#draw();
  }

  connectedCallback() {
    if (!this.#canvas.isConnected) {
      this.#probe.hidden = true;
      this.append(this.#canvas, this.#probe);
      this.#canvas.addEventListener('click', (e) => this.#click(e));
      this.role = 'img';
    }
    this.#resize.observe(this);
    this.#scheme.addEventListener('change', this.#redraw);
  }

  disconnectedCallback() {
    this.#resize.disconnect();
    this.#scheme.removeEventListener('change', this.#redraw);
  }

  #counts() {
    const done = this.#tasks.filter((t) => t.done).length;
    return { done, total: this.#tasks.length };
  }

  #color(token: string) {
    this.#probe.style.color = `var(${token})`;
    return getComputedStyle(this.#probe).color;
  }

  #draw() {
    const size = this.clientWidth;
    if (!size) return;
    const { done, total } = this.#counts();
    this.ariaLabel = `${done} of ${total} tasks done`;

    const dpr = devicePixelRatio || 1;
    const c = this.#canvas;
    c.width = c.height = Math.round(size * dpr);
    c.style.width = c.style.height = `${size}px`;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);

    const r = size / 2, width = size * 0.14;
    const arc = (from: number, to: number, token: string, dim: boolean) => {
      g.globalAlpha = dim ? 0.3 : 1;
      g.strokeStyle = this.#color(token);
      g.lineWidth = width;
      g.beginPath();
      g.arc(r, r, r - width / 2, from - TAU / 4, to - TAU / 4);
      g.stroke();
    };
    if (!total) arc(0, TAU, '--tm-fill', false);
    const split = total ? (done / total) * TAU : 0;
    if (done) arc(0, split, '--tm-success', this.#show === 'open');
    if (done < total) arc(split, TAU, '--tm-accent', this.#show === 'done');

    g.globalAlpha = 1;
    g.fillStyle = this.#color('--tm-text');
    g.font = `600 ${Math.round(size / 6)}px ${getComputedStyle(this).fontFamily}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${done}/${total}`, r, r);
  }

  #click(e: MouseEvent) {
    const { done, total } = this.#counts();
    const r = this.clientWidth / 2, width = this.clientWidth * 0.14;
    const x = e.offsetX - r, y = e.offsetY - r;
    const distance = Math.hypot(x, y);
    if (!total || distance < r - width || distance > r) return;
    const angle = (Math.atan2(y, x) + TAU / 4 + TAU) % TAU;
    const part = angle < (done / total) * TAU ? 'done' : 'open';
    const detail = part === this.#show ? 'all' : part;
    this.dispatchEvent(new CustomEvent('chart-select', { detail, bubbles: true }));
  }
}

customElements.define('task-chart', TaskChart);
