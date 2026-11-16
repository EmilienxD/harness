# Grill-Me board

A private board for visual design interviews with Claude Code, ChatGPT, and Pi. Your agent publishes questions. You explore the options, answer them, and review a prompt to return to the conversation. Each user deploys their own instance. There is no shared public board intended for users. See the [Grill me in cloud guide](../../docs/user/tools/workflows/grill-me-in-cloud.md) for installation and everyday use.

## What you can do

Compare designs with images, diagrams, short video previews, and interactive explanations. Select an option, write a custom answer, or add a note. Add context for the whole round with **Add Additional Notes**. Review the combined prompt before sending it. Send directly to Pi, send through Aboard, or copy into your original conversation. Return to earlier rounds as read-only history.

Continue from your computer or phone. Answers save automatically.

## Personal deployment

You need a Supabase project, a Vercel account, Node.js with npm, and access to this repository. Keep your deployment URL, access code, and server credentials private.

### Prepare Supabase

Create an empty Supabase project. Install the Supabase CLI and open a terminal in the board application's directory. Connect the project and initialize its database and private media storage.

```bash
cd apps/grill
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

### Deploy with Vercel

Import this repository into Vercel. Set the project root directory to `apps/grill`. Add the following server environment variables before deploying.

| Variable | What to enter |
| --- | --- |
| `HARNESS_GRILL_URL` | Your private deployment origin with no trailing slash |
| `HARNESS_GRILL_CODE` | Your chosen four-digit access code |
| `HARNESS_GRILL_SESSION_SECRET` | A long random secret for browser sessions |
| `CRON_SECRET` | A different random secret of at least 16 characters for cleanup |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SECRET_KEY` | Your server-only Supabase secret key |

Keep the Supabase secret key server-side. Never expose it in browser settings or commit it. Deploy the application and open your own deployment URL. Enter your chosen access code to check that the board opens.

### Connect your agent

Install `grill-me-in-cloud` for your provider using the [tool guide](../../docs/user/tools/workflows/grill-me-in-cloud.md). Set the following values in the environment that launches the agent.

```text
HARNESS_GRILL_URL=https://your-board.example
HARNESS_GRILL_CODE=1234
```

Replace both example values with your own deployment settings. Pi returns answers directly through **Send to Pi**. Aboard is optional. For Claude Code or ChatGPT delivery through Aboard, configure the same values in the VS Code environment and initialize the workspace. Restart the agent or reload VS Code after changing its environment. Start an interview and confirm that its private session link opens your board.

Copying the reviewed prompt remains available without direct delivery.

## Keep your board up to date

Update your application checkout and installed Harness tool. Run `supabase db push` for the linked project before deploying the updated application. Redeploy through Vercel and reload open board tabs. Check that you can open a round, save answers, and return a reviewed prompt to your agent.

## Images, videos, and diagrams

Ask the agent for media when it helps explain a decision. Images work without FFmpeg. Video publication requires FFmpeg on the agent's computer. Keep videos short. Each source and prepared video is limited to 20 MiB. A round supports up to 30 assets totaling 50 MiB. Edited diagrams save automatically and can accompany reviewed answers. Use **Reset to original** to discard a diagram's changes.

Review waits for changed diagrams and their images to save. Retry if a save fails.

## Privacy and limits

The board is a personal tool, not a multi-user service. The four-digit code is a lightweight gate, not strong public-facing authentication. Only connect agents whose generated interactive content you trust to run in your browser.

Keep session links and your access code private. Concurrent edits from two devices use the last saved value. Return answers to the original conversation so the agent has the relevant context. Delivery confirmation means the prompt arrived. It does not mean the agent has acted on it. Unfinished sessions remain available. Finishing a session archives it for 30 days before cleanup.

Restore a finished session during that period if you need it again. Publishing a new round restores its session automatically.
