export const API = 'https://api.realworld.show/api';

const KEY = 'jwtToken';

export const token = {
  get: () => localStorage.getItem(KEY),
  set: (t) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
