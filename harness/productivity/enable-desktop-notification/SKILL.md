---
name: enable-desktop-notification
description: User-invoked only. Agents must not invoke this skill on their own. Enable desktop notifications for this session's final responses.
argument-hint: "[--disable]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

This command runs entirely in a hook or native Pi extension before a model turn. Reaching this body means interception failed.

Report that the desktop notification command failed and ask the user to check that the installed hook or extension is enabled and trusted, or reinstall `enable-desktop-notification` through the Harness catalogue. End the turn after reporting the failure.
