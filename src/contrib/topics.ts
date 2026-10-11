import { load } from 'js-yaml';
import { AppError } from '../errors';
import type { GitHubApp, RepositoryRef } from '../github/client';
import { defaultBranch, readFile } from '../github/repository';

export const LANGUAGES = ['en-US', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];
export const RESOURCE_TYPES = ['tools', 'databases', 'learn', 'publications', 'blogs-and-sites', 'events-and-conferences'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export interface MenuNode {
  title: string;
  path: string;
  children?: MenuNode[];
}

export interface Topic {
  lang: Language;
  title: string;
  path: string;
  /** Data folder segments taken from the menu node's path: [category] or [category, subcategory]. */
  segments: string[];
  /** Category title (for labels). */
  category: string;
  categorySegment: string;
}

/** A path segment as used by IPL URLs and data folders: lower-case letters of any script, digits and hyphens. */
const SEGMENT = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]*$/u;

export const isLanguage = (value: unknown): value is Language => typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
export const isResourceType = (value: unknown): value is ResourceType => typeof value === 'string' && (RESOURCE_TYPES as readonly string[]).includes(value);

const MENU_TTL_S = 60 * 60;

/** `_data/<lang>/menu.yaml` from the website repository's default branch, cached in KV for an hour. */
export async function loadMenu(github: GitHubApp, kv: KVNamespace, website: RepositoryRef, lang: Language): Promise<MenuNode[]> {
  const cacheKey = `menu:${website.owner}/${website.repo}:${lang}`.toLowerCase();
  const cached = await kv.get<MenuNode[]>(cacheKey, 'json');
  if (cached) return cached;
  const file = await readFile(github, website, `_data/${lang}/menu.yaml`, await defaultBranch(github, kv, website));
  if (!file) throw new AppError('NOT_CONFIGURED', `The website has no menu for ${lang}.`);
  const menu = load(file.content);
  if (!Array.isArray(menu)) throw new AppError('NOT_CONFIGURED', `The ${lang} menu is not a list.`);
  await kv.put(cacheKey, JSON.stringify(menu), { expirationTtl: MENU_TTL_S });
  return menu as MenuNode[];
}

/**
 * Resolve a topic path to a category or subcategory of the menu. The client string is only compared with menu paths;
 * the data path is then built from the node, never from the string.
 */
export function resolveTopic(menu: MenuNode[], lang: Language, topicPath: unknown): Topic {
  if (typeof topicPath !== 'string' || topicPath.length > 300) {
    throw new AppError('VALIDATION_FAILED', 'topicPath must be the path of an IPL topic page.', { fields: ['topicPath'] });
  }
  const wanted = topicPath.normalize('NFC');
  for (const category of menu) {
    const candidates: { node: MenuNode; depth: number }[] = [{ node: category, depth: 1 }, ...(category.children ?? []).map((node) => ({ node, depth: 2 }))];
    for (const { node, depth } of candidates) {
      if (typeof node.path !== 'string' || node.path.normalize('NFC') !== wanted) continue;
      const segments = node.path.normalize('NFC').split('/').filter(Boolean);
      const [prefix, ...rest] = segments;
      if (prefix !== lang || rest.length !== depth || !rest.every((segment) => SEGMENT.test(segment))) {
        throw new AppError('NOT_FOUND', 'This topic does not accept suggestions.', { topicPath: wanted });
      }
      return {
        lang,
        title: String(node.title ?? ''),
        path: node.path,
        segments: rest,
        category: String(category.title ?? ''),
        categorySegment: rest[0] ?? '',
      };
    }
  }
  throw new AppError('NOT_FOUND', 'Unknown topic.', { topicPath: wanted });
}

/** The resource file the IPL site renders for a topic and type. */
export function resourceFilePath(topic: Topic, type: ResourceType): string {
  return `_data/${topic.lang}/${topic.segments.join('/')}/${type}.yaml`;
}
