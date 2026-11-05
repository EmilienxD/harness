import test from "node:test";
import { runGrillSessionDirectoryJourney } from "../tools/grill-session-directory/run.js";

test("real Codex publishes Grill rounds with session configuration from a child tool directory", { timeout: 90_000 }, runGrillSessionDirectoryJourney);
