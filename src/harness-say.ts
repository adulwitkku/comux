// Bridge `say()` to the Harness event bus (ADR-0023).

import { harnessBus } from "./harness-events.ts";

/** Build a `say` fn that prints and emits a log event. */
export function createSay(print: (msg: string) => void): (msg: string) => void {
  return (msg: string) => {
    print(msg);
    harnessBus.log(msg);
  };
}
