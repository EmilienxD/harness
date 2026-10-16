// Stand-in for a visible terminal: hand the supervisor's launch specification to the journey,
// which opens the child as a real Pi RPC session instead of a TUI it cannot drive headlessly.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [destination, ...argv] = process.argv.slice(2);
const specification = argv.at(-1);
const execution = argv.at(-2);
if (!destination || !specification || !execution) process.exit(2);
mkdirSync(destination, { recursive: true });
copyFileSync(specification, join(destination, `${execution}.json`));
