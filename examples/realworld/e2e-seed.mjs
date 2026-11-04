// Seeds a local RealWorld backend with the demo users the e2e suite expects in "spa" mode
// (johndoe with articles, a second author). Safe to run twice.
//   node e2e-seed.mjs http://localhost:8000/api
const API = process.argv[2] ?? 'http://localhost:8000/api';
const call = async (method, path, body, token) => {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Token ${token}` } : {}) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function user(username) {
  const creds = { email: `${username}@example.com`, password: 'password123' };
  let r = await call('POST', '/users', { user: { username, ...creds } });
  if (r.status >= 400) r = await call('POST', '/users/login', { user: creds });
  if (!r.body?.user?.token) throw new Error(`cannot create or log in ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.user.token;
}

const authors = {
  johndoe: [
    { title: 'Welcome to RealWorld', description: 'An introduction', body: '# Hello\n\nThis is **Conduit**.', tagList: ['welcome', 'introduction'] },
    { title: 'Getting started with Conduit', description: 'First steps', body: 'Write, follow, favorite.', tagList: ['tutorial', 'popular'] },
  ],
  janedoe: [
    { title: 'Markdown tips', description: 'Formatting articles', body: '- lists\n- *emphasis*', tagList: ['markdown', 'popular'] },
    { title: 'Trending topics', description: 'What people read', body: 'Tags help readers.', tagList: ['trending'] },
  ],
};

for (const [name, articles] of Object.entries(authors)) {
  const token = await user(name);
  const { body } = await call('GET', `/articles?author=${name}`);
  if (body?.articlesCount >= articles.length) { console.log(`${name}: already seeded`); continue; }
  for (const article of articles) {
    const { body: created } = await call('POST', '/articles', { article }, token);
    await call('POST', `/articles/${created.article.slug}/comments`, { comment: { body: `A comment by ${name}` } }, token);
  }
  console.log(`${name}: seeded ${articles.length} articles`);
}
