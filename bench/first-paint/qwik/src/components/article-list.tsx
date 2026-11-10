// the global feed, loaded with useResource$: awaited during server rendering, so the HTML has the articles
import { Resource, component$, useContext, useResource$ } from '@builder.io/qwik';
import { Link, useLocation } from '@builder.io/qwik-city';
import { getGlobalArticles } from '~/api';
import { SessionContext } from '~/session';
import { ArticlePreview } from './article-preview';

export const ArticleList = component$(() => {
  const s = useContext(SessionContext);
  const loc = useLocation();
  const articles = useResource$(({ track, cleanup }) => {
    const url = track(() => loc.url);
    const c = new AbortController();
    cleanup(() => c.abort());
    return getGlobalArticles(Number(url.searchParams.get('page') ?? 1), s.authToken, url.searchParams.get('tag') ?? undefined, c.signal);
  });
  return (
    <Resource
      value={articles}
      onPending={() => <div class="article-preview">Loading articles...</div>}
      onRejected={(e) => <div class="article-preview">Error: {e.message}</div>}
      onResolved={(r) => (
        <>
          {r.articles.length ? r.articles.map((a) => <ArticlePreview key={a.slug} article={a} />) : <div class="article-preview">No articles are here... yet.</div>}
          <ul class="pagination">
            {Array.from({ length: Math.ceil(r.articlesCount / 10) }, (_, i) => (
              <li key={i} class={`page-item ${i + 1 == Number(loc.url.searchParams.get('page') ?? 1) ? 'active' : ''}`}><Link class="page-link" href={`/?page=${i + 1}`}>{i + 1}</Link></li>
            ))}
          </ul>
        </>
      )}
    />
  );
});
