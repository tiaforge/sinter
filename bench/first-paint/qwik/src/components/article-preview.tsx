import { component$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';
import { avatar, type Article } from '~/api';

export const ArticlePreview = component$((props: { article: Article }) => {
  const a = props.article;
  return (
    <div class="article-preview">
      <div class="article-meta">
        <Link href={`/profile/${a.author.username}`}><img width={32} height={32} alt="" src={avatar(a.author.image)} /></Link>
        <div class="info">
          <Link href={`/profile/${a.author.username}`} class="author">{a.author.username}</Link>
          <span class="date">{new Date(a.createdAt).toDateString()}</span>
        </div>
        <button class={`btn btn-sm pull-xs-right ${a.favorited ? 'btn-primary' : 'btn-outline-primary'}`}><i class="ion-heart"></i> {a.favoritesCount}</button>
      </div>
      <Link href={`/article/${a.slug}`} class="preview-link">
        <h1>{a.title}</h1>
        <p>{a.description}</p>
        <span>Read more...</span>
        <ul class="tag-list">{a.tagList.map((t) => <li key={t} class="tag-default tag-pill tag-outline">{t}</li>)}</ul>
      </Link>
    </div>
  );
});
