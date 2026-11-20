// The API this app calls (`sinter({ apis })`, docs/apis.md): its base is the spec's server
// (https://api.realworld.show/api), so pages write paths (`src="/articles"`) checked against the spec;
// its origin is allowed on every page, and its resources are requested before the page module. What
// each endpoint returns is said once, here.
export const apis = {
  realworld: {
    openapi: 'openapi.yml',
    defaults: {
      'GET /user': { items: 'user' },
      'GET /articles': { items: 'articles', total: 'articlesCount', key: 'slug' },
      'GET /articles/feed': { items: 'articles', total: 'articlesCount', key: 'slug' },
      'GET /articles/{slug}': { items: 'article' },
      'GET /articles/{slug}/comments': { items: 'comments', key: 'id' },
      'GET /profiles/{username}': { items: 'profile' },
      'GET /tags': { items: 'tags' },
    },
  },
};
