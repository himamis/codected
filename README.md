# codected.com

The website of Codected Solutions SRL, which is mostly Balázs Bencze, who writes software: mobile, web, backend, whatever compiles.

It's a website. It's also an infinite glowing coordinate plane you can pan, zoom and type functions into.
Nobody asked for this. There is a boring version for people who need to get on with their day.

## What's in here

```
site/       the whole website. Plain HTML, CSS and ES modules. No build step, no framework, no regrets.
scripts/    serve.mjs: a tiny static server with zero dependencies
tests/      unit tests for the math parser plus a Playwright smoke test
```

Fonts are self-hosted (`site/assets/fonts/`, SIL Open Font License). three.js only loads from a CDN if you
open the 3D view. Until then it's all ours: no third-party requests on a normal visit.

## Run it

Node 22 or newer.

```sh
npm run serve    # http://localhost:4173  (PORT=8080 npm run serve if 4173 is taken)
npm test         # unit tests, node:test, no install needed
npm run smoke    # Playwright smoke test (run `npm install && npx playwright install chromium` once first)
```

`npm install` only pulls in Playwright for the smoke test. The site has zero runtime dependencies, and
it's staying that way.

## Deploy

Push to `master`. GitHub Actions runs the unit tests and the Playwright smoke test, then publishes `site/`
to the `gh-pages` branch, and GitHub Pages serves that at [codected.com](https://codected.com) (the `CNAME`
lives in `site/`).
If the tests fail, nothing ships, which is more discipline than most of us have.

Things that must stay in `site/`: `CNAME` (the domain) and
`.nojekyll` (so Pages serves the files as they are).

## Easter eggs

Yes. Type `help` in the input box. Or open the console.
