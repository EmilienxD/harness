---
name: enable-desktop-notification
description: Enable desktop notifications for this session's final responses.
argument-hint: "[--disable]"
license: MIT
metadata:
  author: EMB
disable-model-invocation: true
---

This command runs entirely in a hook before a model turn. Reaching this body means interception failed.

Report that the desktop notification command failed and ask the user to check that the installed hook is enabled and trusted, or reinstall `enable-desktop-notification` through the Harness catalogue. End the turn after reporting the failure.
