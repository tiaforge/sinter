// The API this app calls (`sinter({ apis })`, docs/apis.md): its base is the spec's server
// (https://api.realworld.show/api), so pages write paths (`src="/articles"`) checked against the spec;
// its origin is allowed on every page, and its resources are requested before the page module. What
// each endpoint returns is said once, here, and the JWT the API issues: kept in localStorage, sent as
// `Authorization: Token …` (the spec's `Token` scheme), stored from the responses that issue it.
export const apis = {
  realworld: {
    openapi: 'openapi.yml',
    token: {
      storage: 'local:jwtToken',
      scheme: 'Token',
      // where a button's 401 (favorite, follow, delete) and a page that needs a session (`data-sn-signed-in`) send a
      // signed-out visitor; the suite expects `/login` itself (a link's way back is its own `?next=`, article.html)
      signIn: '/login',
      from: { 'POST /users/login': 'user.token', 'POST /users': 'user.token', 'PUT /user': 'user.token' },
    },
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
