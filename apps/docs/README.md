# Harness documentation

The Next.js app renders `../../docs/user/**/*.md` into a static site. Markdown remains
the source of truth; `src/content/site.ts` defines navigation, home cards and branding.
Builds reject missing Markdown links and guides absent from navigation or the unlisted pages.

With Node.js 24 or newer, run from this directory:

```sh
npm ci
npm run dev
```

Run `npm run check` for lint, TypeScript and a production build. The static site is
written to `out/`; serve that directory with any static HTTP server for a production preview.
Assets are copied from `docs/user/assets/` before development and production builds.
Search loads `/search-index.json` on first use.

The Vercel project `harness-docs-emb10` must use **Root Directory: `apps/docs`** and
enable **Include source files outside of the Root Directory**. The app's `vercel.json`
sets the Next.js framework, `npm run build` and the `out` output directory. Keep the
outside-root option enabled so builds can read the Markdown and image sources.
