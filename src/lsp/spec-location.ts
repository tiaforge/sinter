// Where a named schema (or one of its properties) is written in an OpenAPI spec
// file, for go to definition on types generated from it. YAML and JSON alike: the
// `yaml` parser reads both and keeps source ranges.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { typeName } from '../check/openapi-types.js';

export interface SpecLocation { line: number; col: number }

type YamlNode = { range?: [number, number, number]; items?: YamlPair[] } | null | undefined;
type YamlPair = { key: { value?: unknown; range?: [number, number, number] } | null; value: YamlNode };

/** The key named `name` in a YAML map node. */
function pair(map: YamlNode, name: string): YamlPair | undefined {
  return map?.items?.find((p) => p.key?.value === name);
}

function lineCol(text: string, offset: number): SpecLocation {
  let line = 1;
  let start = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') { line++; start = i + 1; }
  return { line, col: offset - start + 1 };
}

/**
 * The position of `components.schemas.<schema>` in `file`, or of its `properties.<prop>` when
 * given and present. `schema` is the TypeScript name; the spec's own name is looked up.
 */
export function specLocation(file: string, schema: string, prop?: string): SpecLocation | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const yaml = createRequire(import.meta.url)('yaml') as typeof import('yaml');
  const doc = yaml.parseDocument(text);
  const schemas = pair(pair(doc.contents as YamlNode, 'components')?.value, 'schemas')?.value;
  const entry = schemas?.items?.find((p) => typeof p.key?.value === 'string' && typeName(p.key.value) === schema);
  if (!entry?.key?.range) return null;
  const property = prop ? pair(pair(entry.value, 'properties')?.value, prop) : undefined;
  const at = property?.key?.range ?? entry.key.range;
  return lineCol(text, at[0]);
}
