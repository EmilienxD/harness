#!/usr/bin/env bash
# aboard runs this file on macOS and Linux, once, right after creating the
# checkout an auto-run works in (aboard.autoRun.worktree.enabled). It runs
# nowhere else and never in your own working tree.
#
# A fresh checkout contains what git tracks and nothing else: no .env, no
# node_modules, no virtualenv. Put whatever makes the project usable here.
#
# The working directory is the new checkout. These are also set:
#
#   ABOARD_SESSION_PATH    the new checkout (same as the working directory)
#   ABOARD_PROJECT_ROOT    your own project directory
#   ABOARD_SESSION_BRANCH  the branch checked out in it
#   ABOARD_RUN_ID          the run this checkout belongs to
#
# A non-zero exit refuses the run, so agents never start in a half-installed
# tree. Anything left untracked and not gitignored refuses it too: the run
# stages with `git add -A`, and a copied .env must not reach a pull request.
#
# This file is yours. aboard never overwrites a copy you have edited.
#
# Example:
#
#   set -euo pipefail
#   cp "$ABOARD_PROJECT_ROOT/.env" .env
#   npm ci
