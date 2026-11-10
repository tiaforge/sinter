import { component$, useContext } from '@builder.io/qwik';
import { Link, useLocation } from '@builder.io/qwik-city';
import { SessionContext } from '~/session';
import { avatar } from '~/api';

export default component$(() => {
  const s = useContext(SessionContext);
  const { url } = useLocation();
  const at = (p: string) => (url.pathname === p ? 'nav-link active' : 'nav-link');
  return (
    <nav class="navbar navbar-light">
      <div class="container">
        <Link class="navbar-brand" href="/">conduit</Link>
        <ul class="nav navbar-nav pull-xs-right">
          <li class="nav-item"><Link class={at('/')} href="/">Home</Link></li>
          {s.isLoggedIn ? (
            <>
              <li class="nav-item"><Link class={at('/editor/')} href="/editor"><i class="ion-compose"></i>&nbsp;New Article</Link></li>
              <li class="nav-item"><Link class={at('/settings/')} href="/settings"><i class="ion-gear-a"></i>&nbsp;Settings</Link></li>
              <li class="nav-item"><Link class="nav-link" href={`/profile/${s.username}`}><img class="user-pic" alt="" src={avatar(s.image)} /> {s.username}</Link></li>
            </>
          ) : (
            <>
              <li class="nav-item"><Link class={at('/login/')} href="/login">Sign in</Link></li>
              <li class="nav-item"><Link class={at('/register/')} href="/register">Sign up</Link></li>
            </>
          )}
        </ul>
      </div>
    </nav>
  );
});
