// auth from cookies, read on the server (as in the reference app's AuthProvider)
import { Slot, component$, createContextId, useContextProvider, useStore, useTask$ } from '@builder.io/qwik';
import { server$ } from '@builder.io/qwik-city';

export interface Session { username: string; image: string | null; isLoggedIn: boolean; authToken: string }
export const SessionContext = createContextId<Session>('session');

const cookies = server$(function () {
  return { username: this.cookie.get('username')?.value, image: this.cookie.get('image')?.value ?? null, authToken: this.cookie.get('authToken')?.value };
});

export default component$(() => {
  const s = useStore<Session>({ username: '', image: null, isLoggedIn: false, authToken: '' });
  useTask$(async () => {
    const c = await cookies();
    if (c.username && c.authToken) Object.assign(s, { username: c.username, image: c.image, isLoggedIn: true, authToken: c.authToken });
  });
  useContextProvider(SessionContext, s);
  return <Slot />;
});
