import { component$, useContext } from '@builder.io/qwik';
import { Link, type DocumentHead } from '@builder.io/qwik-city';
import { SessionContext } from '~/session';
import { ArticleList } from '~/components/article-list';
import Tags from '~/components/tags';

export default component$(() => {
  const s = useContext(SessionContext);
  return (
    <div class="home-page">
      {!s.isLoggedIn && (
        <div class="banner"><div class="container"><h1 class="logo-font">conduit</h1><p>A place to share your knowledge.</p></div></div>
      )}
      <div class="container page">
        <div class="row">
          <div class="col-md-9">
            <div class="feed-toggle">
              <ul class="nav nav-pills outline-active">
                {s.isLoggedIn && <li class="nav-item"><Link class="nav-link" href="/?feed=following">Your Feed</Link></li>}
                <li class="nav-item"><Link class="nav-link active" href="/">Global Feed</Link></li>
              </ul>
            </div>
            <ArticleList />
          </div>
          <Tags />
        </div>
      </div>
    </div>
  );
});

export const head: DocumentHead = { title: 'Home — Conduit' };
