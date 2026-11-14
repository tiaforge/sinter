import { configure } from '@tiaforge-ui/sinter';

// the token from localStorage on every API request
configure({
  request: [async (req, next) => {
    const token = localStorage.getItem('ops.token');
    if (!token) return next(req);
    const headers = new Headers(req.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return next(new Request(req, { headers }));
  }],
});
