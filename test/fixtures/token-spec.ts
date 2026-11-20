// An API whose token is optional on some operations and needed on others (test/behaviour/token.test.ts, test/compiler/token.test.ts).
import { parse } from 'yaml';

/** a RealWorld-like API: `GET /user` and `GET /feed` need the token, `GET /articles` sends it when there is one */
export const TOKEN_SPEC = parse(`openapi: 3.1.0
info: { title: t, version: '1' }
servers: [{ url: 'https://api.example.com/api' }]
paths:
  /user:
    get:
      security: [{ Token: [] }]
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { user: { $ref: '#/components/schemas/User' } } } } } } }
  /feed:
    get:
      security: [{ Token: [] }]
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { articles: { type: array, items: { $ref: '#/components/schemas/Article' } } } } } } } }
  /articles:
    get:
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { articles: { type: array, items: { $ref: '#/components/schemas/Article' } } } } } } } }
  /articles/{slug}/favorite:
    post:
      parameters: [{ name: slug, in: path, required: true }]
      security: [{ Token: [] }]
      responses: { '200': { description: ok } }
  /users/login:
    post:
      requestBody: { content: { application/json: { schema: { type: object } } } }
      responses: { '200': { description: ok, content: { application/json: { schema: { type: object, properties: { user: { $ref: '#/components/schemas/User' } } } } } } }
components:
  securitySchemes:
    Token: { type: apiKey, in: header, name: Authorization }
  schemas:
    User: { type: object, properties: { username: { type: string }, token: { type: string } } }
    Article: { type: object, properties: { slug: { type: string }, favorited: { type: boolean } } }
`);
