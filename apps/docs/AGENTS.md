<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Harness documentation website

The app renders repository Markdown from `../../docs/user/` at build time. Edit guides there;
`src/content/site.ts` owns branding, navigation, unlisted pages and home cards.
Directory navigation groups include new guides automatically. Add other new pages explicitly.
The loader rejects missing Markdown links and pages absent from navigation or `unlistedPages`.

The site uses Next.js App Router with static export. Preserve existing Markdown URLs and
Python-Markdown heading anchors when changing the loader. Search text is fetched from
`/search-index.json` on first use; keep guide content in server modules and pass only navigation
and heading data to the client shell. HTML rendering trusts repository Markdown.

From `apps/docs/` with Node.js 24 or newer:

- `npm ci`: install locked dependencies.
- `npm run dev`: copy source assets and start the local server.
- `npm run check`: lint, typecheck and build the static export in `out/`.

Run `npm run check` after app, Markdown or navigation changes. Check representative old URLs
and anchors, and verify search, themes, the mobile drawer and code copying in a browser.
The postbuild script normalizes Windows segment-prefetch filenames for static hosts.
Asset scripts copy `docs/user/assets/*.png` to ignored `public/assets/`; edit the source assets.

The Vercel project uses repository root directory `apps/docs` with files outside the root
included, because the build reads `docs/user/`. Deployment configuration is in `vercel.json`.
