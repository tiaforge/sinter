# @tiaforge-ui/create

Scaffolds a small task board built with [sinter](https://github.com/tiaforge/sinter) (your JSON API
bound to plain HTML) and [temper](https://github.com/tiaforge/temper) (CSS for semantic HTML).

```sh
npm create @tiaforge-ui my-app
```

It runs against a demo API inside Vite, so there is nothing else to start. The app shows:

- server data with live updates across tabs
- optimistic changes that roll back when the server refuses
- a dialog without JavaScript
- a layout both pages share, and components (one with a script that draws a canvas chart)
- next-page data and page transitions
- build-time checks that turn typos into build errors

The template is in [`template/`](template). Its README lists what to try first.
