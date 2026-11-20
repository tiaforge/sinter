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
      // a button's 401 (favorite, follow, delete) goes to sign in, and back here after (login.html reads `next`)
      signIn: { to: '/login', returnUrl: { allow: ['/'], param: 'next' } },
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
