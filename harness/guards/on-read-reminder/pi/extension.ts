import { registerPathGuard } from "../../hooks/pi-path-guards/path_guards.ts";

export default function (pi: any) {
  registerPathGuard(pi, "on-read-reminder");
}
