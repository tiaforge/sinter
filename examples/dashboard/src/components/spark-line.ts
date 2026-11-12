// The script of <spark-line>: it keeps the graph's window of samples. The page gives it the history once
// (`seed`); after that only the newest number arrives, and each new `at` appends it. The points are drawn by
// sinter from `samples` (the component's state); the script also slides the line one step left, so it
// moves instead of jumping.
import { SparkLineComponent } from './spark-line.html';

/** 30 seconds at the server's four samples a second, plus one just past the left edge (see the markup) */
const SAMPLES = 120;

export class SparkLine extends SparkLineComponent {
  #seeded = false;
  #at = 0;
  #stamp = 0;
  #slide: Animation | null = null;

  propsChanged() {
    const { value, at, seed, width } = this.props;
    if (!this.#seeded) {
      if (!seed.length) return; // the history has not loaded yet
      this.#seeded = true;
      this.#at = at;
      this.state.samples = [...seed];
      return;
    }
    if (at === this.#at) return; // something else changed (a label, a tone), not the number
    this.#at = at;
    const samples = [...this.state.samples.slice(-SAMPLES), value];
    this.state.samples = samples;

    // glide for as long as the samples arrive apart, so the motion neither stops nor waits
    const now = performance.now();
    const duration = Math.min(Math.max(now - this.#stamp, 50), 1000);
    this.#stamp = now;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    this.#slide?.cancel();
    this.#slide = this.refs.plot.animate(
      [{ transform: `translateX(${width / Math.max(samples.length - 2, 1)}px)` }, { transform: 'translateX(0)' }],
      { duration, easing: 'linear' },
    );
  }

  disconnected() { this.#slide?.cancel(); }
}
