import { UiCardComponent } from './ui-card.html';

/** marks the card once it is connected, from its script */
export class UiCard extends UiCardComponent {
  connected() {
    this.root.dataset.ready = this.props.title;
  }
}
