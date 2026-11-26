import { z } from "zod";

export const bindingEvent = z.enum([
  "issue_comment.created",
  "issues.opened",
  "issues.labeled",
  "issues.closed",
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "push",
]);
