import { singleLine } from '../text';
import type { Language } from './topics';

/** Titles and labels of contribution pull requests (issue #9). */
export const MAX_TITLE = 120;

export function pullRequestTitle(kind: 'edit' | 'suggestion', subject: string): string {
  const prefix = kind === 'edit' ? 'Edit: ' : 'Resource suggestion: ';
  return singleLine(`${prefix}${singleLine(subject, MAX_TITLE)}`, MAX_TITLE);
}

export interface LabelInput {
  kind: 'edit' | 'suggestion';
  lang: Language;
  /** Category data folder of the topic (suggestions), e.g. `computing`. */
  topic?: string;
  containsHtml?: boolean;
}

/**
 * `contribution` + `edit`|`suggestion` + `lang:<lang>` (+ `topic:<category>`, + `contains-html`). GitHub creates a label
 * the first time it is added, so content repositories need no setup; maintainers may recolour them afterwards.
 */
export function contributionLabels({ kind, lang, topic, containsHtml }: LabelInput): string[] {
  const labels = ['contribution', kind, `lang:${lang}`];
  if (topic && /^[\p{Ll}\p{Lo}\p{N}-]{1,40}$/u.test(topic)) labels.push(`topic:${topic}`);
  if (containsHtml) labels.push('contains-html');
  return labels;
}

/** The page title from front matter (`title:`), falling back to the file path. */
export function pageTitle(source: string, path: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  const title = match?.[1] ? /^title:\s*["']?(.*?)["']?\s*$/m.exec(match[1])?.[1] : undefined;
  return title?.trim() || path;
}
