# GitHub Agent Channel

- Build a runtime-independent GitHub collaboration channel. OpenClaw is the first connector, not the core runtime.
- Keep secrets in environment variables or secret files outside Git; public config contains references only.
- Verify raw webhook bytes before parsing. Persist accepted tasks before acknowledging. Do not execute long jobs in the webhook handler.
- Task context is constructed server-side. Agent tools cannot override connection, installation, repository, actor or target issue.
- Separate installation access from actor authorization. Re-check authorization before outbound effects.
- Use tests for behavior, including duplicates, unauthorized calls, transport ambiguity, restart and output delivery.
- No automatic replay of ambiguous external side effects. No claims of exactly-once external execution.
- Keep this implementation milestone explicit in docs. Do not describe mocked checks as live GitHub/OpenClaw verification.
- Do not create PRs or merge without user request; commit and push to the authorized development branch.
