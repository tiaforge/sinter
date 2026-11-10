import { Resource, component$, useResource$ } from '@builder.io/qwik';
import { Link } from '@builder.io/qwik-city';
import { getTags } from '~/api';

export default component$(() => {
  const tags = useResource$(() => getTags());
  return (
    <div class="col-md-3">
      <div class="sidebar">
        <p>Popular Tags</p>
        <Resource value={tags} onPending={() => <div>Loading tags...</div>} onRejected={(e) => <div>Error: {e.message}</div>}
          onResolved={(list) => <div class="tag-list">{list.map((t) => <Link key={t} class="tag-pill tag-default" href={`/?tag=${t}`}>{t}</Link>)}</div>} />
      </div>
    </div>
  );
});
