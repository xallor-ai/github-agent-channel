import { z } from "zod";

export const failureCodes = {
  failed: z.enum([
    "tool_call_invalid",
    "tool_call_failed",
    "tool_round_limit",
    "no_final_answer",
    "runtime_response_invalid",
    "runtime_failed",
    "review_diff_unavailable",
    "preparation_interrupted",
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

// Only definitive execution or input-evidence failures qualify for a Channel-authored status notice.
export const notifiableFailures = [
  "tool_call_failed",
  "tool_round_limit",
  "no_final_answer",
  "runtime_response_invalid",
  "tool_call_invalid",
  "review_diff_unavailable",
] as const satisfies readonly RuntimeFailureCode[];
export const failedExecutionMessage = (code: RuntimeFailureCode) =>
  `Connector execution failed (${code})`;
export function noticeFailureCode(error: string | null) {
  return notifiableFailures.find(
    (code) => failedExecutionMessage(code) === error,
  );
}
