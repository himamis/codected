# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: prospective clients.** Companies and founders deciding whether to hire Codected Solutions SRL for software work: mobile, web, backend, tooling. They want to know who Balázs is, what he has built, what he works in, and how to reach him. Success is an email to balazs@codected.com.
- **Secondary: peers and curious developers.** They come for the playground (the plane, typing functions, the easter eggs) and pass it around. Welcome, but the site is not built for them first.
- **Visitors in a hurry.** Some clients just need the facts. The "boring version" serves them, along with no-JS and assistive-tech users.

## Product Purpose

codected.com is the website of Codected Solutions SRL, which is essentially one engineer, Balázs Bencze, based in Romania. It has to win client work. The playful side (an infinite, glowing coordinate plane you can pan, zoom, and type functions into) is how it stands out, and it also proves the craft directly: the site itself is a working graphing calculator.

## Positioning

A one-person studio where you talk directly to the person writing the code. Balázs builds GeoGebra's iOS and Android apps (graphing, geometry, 3D and CAS for millions of students) and works on Mapplic (interactive maps from images and SVGs). The site makes the same claim through what it is: a math engine and an interactive map, built from scratch with zero dependencies. A competitor cannot honestly copy that.

## Operating Context

- Places on the plane: Hello, GeoGebra, Mapplic, Stack, Contact (keys 1–5, with a guided tour that loops). Defined in `site/assets/js/content.js`.
- Input box that accepts functions and commands (`help`), a 3D view (three.js, loaded on demand), a minimap, and console easter eggs.
- Phones and tablets (`pointer: coarse`) get "lite" mode: the same look with much less GPU work.
- The boring version is a toggle in the HUD and also the `<noscript>` fallback.

## Capabilities and Constraints

- **Zero runtime dependencies.** Plain HTML, CSS, and ES modules. No build step, no framework. A normal visit makes no third-party requests; three.js loads from a CDN only when the 3D view opens. Fonts are self-hosted (Bricolage Grotesque, JetBrains Mono; OFL).
- **Boring version stays.** A plain, accessible, facts-only version must always be available, both as a toggle and when JavaScript is off.
- **Static GitHub Pages deploy.** A push to `master` runs the unit tests (`tests/math.test.mjs`) and the Playwright smoke test (`tests/smoke.mjs`), then publishes `site/` to `gh-pages`. `site/CNAME` and `site/.nojekyll` must stay.
- **Removed on purpose:** RunGear (project page, privacy policy, terms) and `app-ads.txt` are retired. Do not restore them.
- Legacy URLs (`/projects/`, `/projects/geogebra/`) redirect to the plane.

## Brand Commitments

- Name: **codected** (lowercase wordmark). Legal entity: Codected Solutions SRL, Romania.
- **Voice: dry, irreverent, self-deprecating.** "Nobody asked for this." "Whatever compiles." "404 · Point not on curve." Plain about facts, playful about everything around them. This voice is binding.
- Mark: coordinate axes with a curve (`site/favicon.svg`, the brand button in the HUD).

## Evidence on Hand

- Real work: GeoGebra (geogebra.org) and Mapplic (mapplic.com). Images in `site/assets/img/` (`geogebra.*`, `mapplic-map.svg`), plus a portrait (`balazs.*`) and an OG image (`og.jpg`).
- Stack list: Kotlin, Swift, TypeScript, Dart/Flutter, Java, Objective-C, JavaScript, Python, SQL, backend and APIs.
- Contact: balazs@codected.com; support: support@codected.com.
- **Not on hand:** no client testimonials, case-study metrics, client logos, pricing, or availability statements. Do not invent them.

## Product Principles

1. **Clients first, fun second, but the fun is the pitch.** Every playful element should also show competence. None of it should stand between a client and the facts or the email address.
2. **Show, don't claim.** The site proves the skill by working. Prefer demonstrations over adjectives.
3. **Always an exit to the facts.** The boring version is a first-class product, not a fallback.
4. **Ours, all the way down.** No dependencies, no trackers, no third-party requests unless the visitor asks for them.
5. **Honest and small.** One person, real projects, no inflated claims.

## Accessibility & Inclusion

- A skip link leads to the boring version. The no-JS fallback renders all the facts.
- The plane is decorative to assistive tech (`aria-hidden`). All content must stay reachable without it.
- Respect reduced motion and keep lite mode workable on low-power devices.
