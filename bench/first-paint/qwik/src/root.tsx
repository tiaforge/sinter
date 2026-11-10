import { component$ } from '@builder.io/qwik';
import { QwikCityProvider, RouterOutlet, useDocumentHead } from '@builder.io/qwik-city';
import Session from './session';

const Head = component$(() => {
  const head = useDocumentHead();
  return <title>{head.title}</title>;
});

export default component$(() => (
  <QwikCityProvider>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="data:," />
      <link rel="stylesheet" href="https://code.ionicframework.com/ionicons/2.0.1/css/ionicons.min.css" />
      <link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Titillium+Web:700|Source+Serif+Pro:400,700|Merriweather+Sans:400,700|Source+Sans+Pro:400,300,600,700,300italic,400italic,600italic,700italic" />
      <link rel="stylesheet" href="/styles.css" />
      <Head />
    </head>
    <body>
      <Session>
        <RouterOutlet />
      </Session>
    </body>
  </QwikCityProvider>
));
