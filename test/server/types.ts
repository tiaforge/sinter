// `embed<Build>()`: the build's placeholders as types (the sinter-embed.d.ts the build writes), checked by
// `npm run typecheck`. Each @ts-expect-error is a configuration the build refuses; the rest compile.
import { embed } from '../../src/server.js';

// as the Vite plugin writes it: `articles` has no request the build describes, `tags` and `user` do
interface Build {
  pages: {
    'index.html': { tags: true; articles: false; user: true };
    'profile.html': { articles: false; profile: true };
  };
}

export async function typed() {
  // every placeholder the build cannot describe has an entry: by its name (every page)…
  await embed<Build>({ dir: 'dist', data: { articles: () => [] } });
  // …or by each page's
  await embed<Build>({ dir: 'dist', data: { 'index.html:articles': 'skip', 'profile.html:articles': (r) => r.params.username } });
  // with other entries too
  await embed<Build>({ dir: 'dist', data: { articles: 'skip', user: 'skip', 'profile.html:profile': () => ({}) } });

  // @ts-expect-error `articles` has no source
  await embed<Build>({ dir: 'dist', data: { user: 'skip' } });
  // @ts-expect-error `articles` has none on profile.html
  await embed<Build>({ dir: 'dist', data: { 'index.html:articles': 'skip' } });
  // @ts-expect-error a name no placeholder has (a typo)
  await embed<Build>({ dir: 'dist', data: { articles: 'skip', usr: 'skip' } });
  // @ts-expect-error neither a resolver nor 'skip'
  await embed<Build>({ dir: 'dist', data: { articles: 'skp' } });
  // @ts-expect-error no data at all
  await embed<Build>({ dir: 'dist' });

  // without the build's types: any names (the startup check still applies)
  await embed({ dir: 'dist', data: { anything: 'skip' } });
}
