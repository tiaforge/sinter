// the same mock API sinter's RealWorld uses in this comparison
export const BASE_URL = 'http://localhost:4400/api';

export interface Author { username: string; image: string | null; following: boolean }
export interface Article { slug: string; title: string; description: string; body: string; tagList: string[]; createdAt: string; favorited: boolean; favoritesCount: number; author: Author }
export interface Comment { id: number; body: string; createdAt: string; author: Author }

const get = async <T,>(path: string, token?: string, signal?: AbortSignal): Promise<T> => {
  const r = await fetch(BASE_URL + path, { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) }, signal });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
};
export const getGlobalArticles = (page: number, token?: string, tag?: string, signal?: AbortSignal) =>
  get<{ articles: Article[]; articlesCount: number }>(`/articles?${tag ? `tag=${encodeURIComponent(tag)}&` : ''}limit=10&offset=${(page - 1) * 10}`, token, signal);
export const getTags = () => get<{ tags: string[] }>('/tags').then((x) => x.tags);
export const getArticle = (slug: string, token?: string, signal?: AbortSignal) => get<{ article: Article }>(`/articles/${slug}`, token, signal).then((x) => x.article);
export const getComments = (slug: string, token?: string) => get<{ comments: Comment[] }>(`/articles/${slug}/comments`, token).then((x) => x.comments);
export const avatar = (src: string | null) => src || '/default-avatar.svg';
