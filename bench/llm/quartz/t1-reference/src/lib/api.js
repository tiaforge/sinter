/* global __API_PORT__ */
export const API = `http://localhost:${__API_PORT__}/api`;

/** A JSON request to the incident API; resolves to the Response, or null when the network fails. */
export function send(method, path, body) {
  return fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  }).catch(() => null);
}

/** The JSON body of a response, or {} when there is none. */
export const json = (r) => (r && r.status !== 204 ? r.json().catch(() => ({})) : Promise.resolve({}));
