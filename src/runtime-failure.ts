import { z } from "zod";

export const failureCodes = {
  failed: z.enum([
    "tool_call_invalid",
    "tool_call_failed",
    "tool_round_limit",
    "no_final_answer",
    "runtime_response_invalid",
    "runtime_failed",
  ]),
  unknown: z.enum([
    "runtime_interrupted",
    "runtime_timeout",
    "runtime_transport",
  ]),
};
export type RuntimeFailureCode = z.infer<
  (typeof failureCodes)[keyof typeof failureCodes]
>;
export class RuntimeFailure extends Error {
  constructor(
    readonly code: RuntimeFailureCode,
    message: string,
  ) {
    super(message);
  }
}

// Only definitive model-output failures qualify for a Channel-authored status notice.
export const notifiableFailures = [
  "tool_round_limit",
  "no_final_answer",
  "runtime_response_invalid",
  "tool_call_invalid",
] as const satisfies readonly RuntimeFailureCode[];
export const failedExecutionMessage = (code: RuntimeFailureCode) =>
  `Connector execution failed (${code})`;
export function noticeFailureCode(error: string | null) {
  return notifiableFailures.find(
    (code) => failedExecutionMessage(code) === error,
  );
}
