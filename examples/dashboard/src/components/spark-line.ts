// The script of <spark-line>: the browser work markup cannot do. sinter draws the points; each time a new
// sample arrives (`at` changes) every point is one step too far left, so this slides the line back from
// where it was, and it moves instead of jumping. It writes no node sinter renders: only an animation on
// the group (its ref, declared in the HTML).
import { SparkLineComponent } from './spark-line.html';

export class SparkLine extends SparkLineComponent {
  #at: number | null = null;
  #stamp = 0;
  #slide: Animation | null = null;

  propsChanged() {
    const { at, width, values } = this.props;
    if (at === this.#at) return; // something else changed (a label, a tone), not the samples
    const first = this.#at === null;
    this.#at = at;
    // glide for as long as the samples arrive apart, so the motion neither stops nor waits
    const now = performance.now();
    const duration = Math.min(Math.max(now - this.#stamp, 50), 1000);
    this.#stamp = now;
    if (first || values.length < 3 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.#slide?.cancel();
    this.#slide = this.refs.plot.animate(
      [{ transform: `translateX(${width / (values.length - 2)}px)` }, { transform: 'translateX(0)' }],
      { duration, easing: 'linear' },
    );
  }

  disconnected() { this.#slide?.cancel(); }
}
