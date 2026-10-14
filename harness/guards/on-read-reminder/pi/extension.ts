import { registerPathGuard } from "../../hooks/pi-support/bridge.ts";

export default function (pi: any) {
  registerPathGuard(pi, "on-read-reminder");
}
