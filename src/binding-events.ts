import { z } from "zod";

export const bindingEvent = z.enum([
  "issue_comment.created",
  "issues.opened",
  "issues.labeled",
  "pull_request.opened",
  "pull_request.synchronize",
  "push",
]);
