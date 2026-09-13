import test from "node:test";
import { runCommitJourney } from "../tools/commit/run.js";
test("commit hook commits the real CLI edit without another inference request", { timeout: 180000 }, runCommitJourney);
