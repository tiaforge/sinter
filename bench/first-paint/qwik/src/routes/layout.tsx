import { component$, Slot } from '@builder.io/qwik';
import type { RequestHandler } from '@builder.io/qwik-city';
import Header from '~/components/header';

// as in the reference app: a short shared cache, revalidated in the background
export const onGet: RequestHandler = async ({ cacheControl }) => {
  cacheControl({ staleWhileRevalidate: 60 * 60 * 24 * 7, maxAge: 5 });
};

export default component$(() => (
  <>
    <Header />
    <main><Slot /></main>
    <footer><div class="container"><a href="/" class="logo-font">conduit</a><span class="attribution">An interactive learning project.</span></div></footer>
  </>
));
