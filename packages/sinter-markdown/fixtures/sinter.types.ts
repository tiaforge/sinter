// The fixture pages' types module, as an app writes its own: the tree's types from the package, and
// the shape of the comments the fixture API sends.
export type { Root, TocEntry } from '@tiaforge-ui/sinter-markdown';

export interface Comment {
  id: number;
  author: string;
  /** markdown, written by a reader */
  body: string;
}
