export const API = 'https://api.realworld.show/api';

const KEY = 'jwtToken';

/** on its own, so the early files (the signed-out header) bundle only this, not the whole `token` */
export const getToken = () => localStorage.getItem(KEY);

export const token = {
  get: getToken,
  set: (t) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
};

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
