// the article and its comments, loaded with useResource$ (rendered on the server)
import { Resource, component$, useResource$ } from '@builder.io/qwik';
import { Link, useLocation, type DocumentHead } from '@builder.io/qwik-city';
import { avatar, getArticle, getComments } from '~/api';

export default component$(() => {
  const { params } = useLocation();
  const article = useResource$(({ track }) => getArticle(track(() => params.slug)));
  const comments = useResource$(({ track }) => getComments(track(() => params.slug)));
  return (
    <Resource value={article} onPending={() => <div>Loading article...</div>} onRejected={(e) => <div>Error: {e.message}</div>}
      onResolved={(a) => (
        <div class="article-page">
          <div class="banner">
            <div class="container">
              <h1>{a.title}</h1>
              <div class="article-meta">
                <Link href={`/profile/${a.author.username}`}><img alt="" src={avatar(a.author.image)} /></Link>
                <div class="info"><Link href={`/profile/${a.author.username}`} class="author">{a.author.username}</Link><span class="date">{new Date(a.createdAt).toDateString()}</span></div>
                <button class="btn btn-sm btn-outline-secondary"><i class="ion-plus-round"></i>&nbsp; Follow {a.author.username}</button>
                &nbsp;&nbsp;
                <button class="btn btn-sm btn-outline-primary"><i class="ion-heart"></i>&nbsp; Favorite Article <span class="counter">({a.favoritesCount})</span></button>
              </div>
            </div>
          </div>
          <div class="container page">
            <div class="row article-content"><div class="col-md-12"><p>{a.body}</p><ul class="tag-list">{a.tagList.map((t) => <li key={t} class="tag-default tag-pill tag-outline">{t}</li>)}</ul></div></div>
            <hr />
            <div class="row">
              <div class="col-xs-12 col-md-8 offset-md-2">
                <p><Link href="/login">Sign in</Link> or <Link href="/register">sign up</Link> to add comments on this article.</p>
                <Resource value={comments} onPending={() => <div>Loading comments...</div>} onRejected={() => <div />}
                  onResolved={(list) => <>{list.map((c) => (
                    <div key={c.id} class="card">
                      <div class="card-block"><p class="card-text">{c.body}</p></div>
                      <div class="card-footer"><span class="comment-author"><img alt="" src={avatar(c.author.image)} class="comment-author-img" /></span>&nbsp;<span class="comment-author">{c.author.username}</span><span class="date-posted">{new Date(c.createdAt).toDateString()}</span></div>
                    </div>))}</>} />
              </div>
            </div>
          </div>
        </div>
      )} />
  );
});

export const head: DocumentHead = { title: 'Article — Conduit' };
