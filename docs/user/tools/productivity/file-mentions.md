# File mentions

Platforms: **Pi**.

Include a text file or folder listing in your prompt by mentioning its path. Install with `harness install file-mentions --platform pi`, then restart Pi or run `/reload`.

See [Get started](../../getting-started.md) for user-scope installation.

## When to use it

Give the agent specific context without asking it to find the same material first. Include a design document or compare the contents of a few folders.

## Use it

Type `@` followed by the path in your prompt. Quote paths containing spaces, such as `@"docs/design notes.md"`. A text file adds its contents. A folder adds a bounded listing. Relative paths start from Pi's current working directory. Mentioning the same resource twice loads it only once for that prompt. A later prompt reads the current contents again.

Check the notification to see which references loaded or were skipped.

## Privacy and limits

File contents are sent to the model and saved with the conversation even when the transcript shows only your original prompt. Do not mention secret files unless you intend to share their contents. Large or unavailable resources can be skipped or truncated. Check the reported result. Mentions inside code examples are ignored.
