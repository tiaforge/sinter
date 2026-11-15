/** a node of `<ui-tree>` */
export interface Item {
  id: number;
  label: string;
  children?: Item[];
}

/** how loud `<ui-card>` is */
export type Tone = 'plain' | 'loud';
