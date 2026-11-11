// The script of <task-chart>: the browser work markup cannot do (drawing on a canvas). Its props,
// event and refs are declared in task-chart.html, and typed through the base class generated from it
// (src/sinter.components.d.ts). sinter runs it once per instance; it writes no node sinter renders.
import { TaskChartComponent } from './task-chart.html';

const TAU = 2 * Math.PI;

export class TaskChart extends TaskChartComponent {
  #resize = new ResizeObserver(() => this.draw());
  #scheme = matchMedia('(prefers-color-scheme: dark)');
  #redraw = () => this.draw();

  connected() {
    this.refs.canvas.addEventListener('click', (e) => this.click(e));
    this.#resize.observe(this.root);
    this.#scheme.addEventListener('change', this.#redraw);
  }

  propsChanged() { this.draw(); }

  disconnected() {
    this.#resize.disconnect();
    this.#scheme.removeEventListener('change', this.#redraw);
  }

  counts() {
    const done = this.props.tasks.filter((t) => t.done).length;
    return { done, total: this.props.tasks.length };
  }

  color(token: string) {
    this.refs.probe.style.color = `var(${token})`;
    return getComputedStyle(this.refs.probe).color;
  }

  draw() {
    const size = this.root.clientWidth;
    if (!size) return;
    const { done, total } = this.counts();
    const dpr = devicePixelRatio || 1;
    const c = this.refs.canvas;
    c.width = c.height = Math.round(size * dpr);
    c.style.width = c.style.height = `${size}px`;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);

    const r = size / 2, width = size * 0.14;
    const arc = (from: number, to: number, token: string, dim: boolean) => {
      g.globalAlpha = dim ? 0.3 : 1;
      g.strokeStyle = this.color(token);
      g.lineWidth = width;
      g.beginPath();
      g.arc(r, r, r - width / 2, from - TAU / 4, to - TAU / 4);
      g.stroke();
    };
    if (!total) arc(0, TAU, '--tm-fill', false);
    const split = total ? (done / total) * TAU : 0;
    if (done) arc(0, split, '--tm-success', this.props.show === 'open');
    if (done < total) arc(split, TAU, '--tm-accent', this.props.show === 'done');

    g.globalAlpha = 1;
    g.fillStyle = this.color('--tm-text');
    g.font = `600 ${Math.round(size / 6)}px ${getComputedStyle(this.root).fontFamily}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(`${done}/${total}`, r, r);
  }

  /** a click on a part picks its filter, or all when that part is already shown */
  click(e: MouseEvent) {
    const { done, total } = this.counts();
    const r = this.root.clientWidth / 2, width = this.root.clientWidth * 0.14;
    const x = e.offsetX - r, y = e.offsetY - r;
    const distance = Math.hypot(x, y);
    if (!total || distance < r - width || distance > r) return;
    const angle = (Math.atan2(y, x) + TAU / 4 + TAU) % TAU;
    const part = angle < (done / total) * TAU ? 'done' : 'open';
    this.emit('pick', part === this.props.show ? 'all' : part);
  }
}
