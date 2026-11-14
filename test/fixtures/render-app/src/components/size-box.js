import { SizeBoxComponent } from './size-box.html';

// measures itself, as a chart does: on jsdom the observer is a stand-in that never calls back
export class SizeBox extends SizeBoxComponent {
  #resize = new ResizeObserver(() => {});
}
