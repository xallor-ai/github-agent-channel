import type { DatabaseSync } from "node:sqlite";
import type { NewTask, PublicationReceipt, Task } from "./contracts.js";
import { threadKey } from "./activity-ledger.js";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const explicit =
  /^\/answer[ \t]+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s+(\S[\s\S]*)$/i;
type Match =
  | { reason: "clarification_pending"; questionId: string }
  | { reason: "clarification_reply"; questionId: string; answer: string }
  | { reason: "clarification_ambiguous"; choices: string[] }
  | { reason: "clarification_unmatched" };

/** A question is one published execution; children remain executions of the same root. */
export class ClarificationLedger {
  constructor(private readonly db: DatabaseSync) {}
  context(id: string): Pick<Task, "continuation" | "questionChoices"> {
    const prior = this.db
      .prepare(
        "SELECT q.rootTaskId,q.questionTaskId,r.prompt AS originalPrompt,json_extract(t.outcome,'$.text') AS question FROM clarifications q JOIN tasks r ON r.id=q.rootTaskId JOIN tasks t ON t.id=q.questionTaskId WHERE q.answerTaskId=?",
      )
      .get(id);
    if (prior) {
      const history: { question: string; answer: string }[] = [];
      let parent = String(prior.questionTaskId);
      while (parent !== prior.rootTaskId) {
        const step = this.db
          .prepare(
            "SELECT q.questionTaskId,json_extract(t.outcome,'$.text') AS question,a.prompt AS answer FROM clarifications q JOIN tasks t ON t.id=q.questionTaskId JOIN tasks a ON a.id=q.answerTaskId WHERE q.answerTaskId=? AND q.rootTaskId=?",
          )
          .get(parent, prior.rootTaskId!);
        if (!step || history.length >= 3)
          throw Error("Invalid clarification lineage");
        history.unshift({
          question: String(step.question),
          answer: String(step.answer),
        });
        parent = String(step.questionTaskId);
      }
      return {
        continuation: {
          rootTaskId: String(prior.rootTaskId),
          questionTaskId: String(prior.questionTaskId),
          originalPrompt: String(prior.originalPrompt),
          question: String(prior.question),
          history,
        },
      };
    }
    const pick = this.db
      .prepare("SELECT choices FROM clarificationSelections WHERE taskId=?")
      .get(id);
    return pick ? { questionChoices: JSON.parse(String(pick.choices)) } : {};
  }
  open(task: Task, receipt: PublicationReceipt | undefined) {
    if (task.outcome?.publication.kind !== "clarification") return;
    const target = task.target;
    if (
      target.kind === "repository" ||
      receipt?.kind !== "comment" ||
      !Number.isSafeInteger(receipt.id) ||
      !receipt.id ||
      receipt.id < 1 ||
      !Number.isSafeInteger(receipt.createdAt) ||
      !receipt.createdAt ||
      receipt.createdAt < 1 ||
      receipt.url !==
        `https://github.com/${task.owner}/${task.repo}/${target.kind === "issue" ? "issues" : "pull"}/${target.number}#issuecomment-${receipt.id}`
    )
      throw Error("Missing verified question publication receipt");
    const root = task.continuation?.rootTaskId ?? task.id,
      thread = threadKey(target);
    this.db
      .prepare(
        `INSERT INTO clarifications(questionTaskId,rootTaskId,bindingId,thread,actorId,askedAt,expiresAt,closed) SELECT ?,?,?,?,?,?,?,EXISTS(SELECT 1 FROM threadClosures c JOIN tasks t ON t.id=? WHERE c.repositoryId=t.repositoryId AND c.thread=? AND (c.closedAt IS NULL OR t.githubTime IS NULL OR c.closedAt>=t.githubTime))`,
      )
      .run(
        task.id,
        root,
        task.bindingId,
        thread,
        task.actorId,
        receipt.createdAt,
        receipt.createdAt + WEEK,
        root,
        thread,
      );
  }
  match(
    input: NewTask,
    time: number | undefined,
    ordinary: boolean,
  ): Match | undefined {
    if (
      input.source.event !== "issue_comment" ||
      input.source.action !== "created" ||
      !input.source.commentId ||
      input.target.kind === "repository" ||
      input.prompt.length > 16000
    )
      return;
    const body = input.prompt.trimEnd(),
      selector = /^\/answer(?=\s|$)/i.test(body.trimStart());
    if (!selector && !ordinary) return;
    // Do not consume a command addressed elsewhere. Later lines may contain
    // the very commands or logs the question asked the user to supply.
    if (
      !selector &&
      /^(?:@[a-z0-9]|\/[a-z][\w-]*(?=\s|$))/i.test(body.trimStart())
    )
      return;
    const selected = selector ? explicit.exec(body) : null;
    const unmatched = { reason: "clarification_unmatched" } as const;
    if ((selector && !selected) || !time || !Number.isSafeInteger(time))
      return selector ? unmatched : undefined;
    // An unconfirmed write could already be visible on GitHub. In that window
    // never give an implicit reply to a different, older confirmed question.
    if (
      !selector &&
      this.db
        .prepare(
          "SELECT 1 FROM tasks WHERE bindingId=? AND actorId=? AND json_extract(target,'$.kind')=? AND json_extract(target,'$.number')=? AND deliveryStatus IN ('sending','unknown') AND json_extract(outcome,'$.publication.kind')='clarification' LIMIT 1",
        )
        .get(
          input.bindingId,
          input.actorId,
          input.target.kind,
          input.target.number,
        )
    )
      return undefined;
    // Ordering is based on GitHub timestamps, not delivery order. A prompt can only
    // consume one question and a question can only be consumed once.
    const rows = this.db
      .prepare(
        `SELECT questionTaskId,askedAt FROM clarifications WHERE bindingId=? AND thread=? AND actorId=? AND closed=0 AND answerTaskId IS NULL AND expiresAt>? AND expiresAt>? AND askedAt<=? ${selected ? "AND questionTaskId=?" : ""} ORDER BY askedAt DESC,questionTaskId LIMIT 8`,
      )
      .all(
        input.bindingId,
        threadKey(input.target),
        input.actorId,
        time,
        Date.now(),
        time,
        ...(selected ? [selected[1].toLowerCase()] : []),
      );
    if (!rows.length && selected) {
      const questionId = selected[1].toLowerCase();
      const pending = this.db
        .prepare(
          "SELECT 1 FROM tasks WHERE id=? AND bindingId=? AND actorId=? AND json_extract(target,'$.kind')=? AND json_extract(target,'$.number')=? AND status='succeeded' AND publicationBlocked=0 AND deliveryStatus IN ('sending','unknown') AND json_extract(outcome,'$.publication.kind')='clarification'",
        )
        .get(
          questionId,
          input.bindingId,
          input.actorId,
          input.target.kind,
          input.target.number,
        );
      if (pending) return { reason: "clarification_pending", questionId };
    }
    if (!rows.length || rows.some((r) => r.askedAt === time))
      return selector ? unmatched : undefined;
    if (rows.length === 1)
      return {
        reason: "clarification_reply",
        questionId: String(rows[0].questionTaskId),
        answer: selected ? selected[2] : input.prompt,
      };
    return {
      reason: "clarification_ambiguous",
      choices: rows.map((r) => String(r.questionTaskId)),
    };
  }
  private resolveCandidate(cursor: number, id: string | null) {
    const reason = id ? "clarification_reply" : "clarification_unmatched";
    this.db
      .prepare(
        "UPDATE deliveries SET reason=?,taskId=? WHERE cursor=? AND reason='clarification_pending'",
      )
      .run(reason, id, cursor);
    this.db
      .prepare(
        "UPDATE activities SET data=json_set(data,'$.reason',?,'$.taskId',?) WHERE cursor=? AND json_extract(data,'$.reason')='clarification_pending'",
      )
      .run(reason, id, cursor);
    if (id)
      this.db
        .prepare(
          "UPDATE ownerReceipts AS r SET taskId=?,reactionStatus='pending' WHERE cursor=? AND taskId IS NULL AND NOT EXISTS(SELECT 1 FROM ownerReceipts other WHERE other.repositoryId=r.repositoryId AND other.commentId=r.commentId AND other.taskId IS NOT NULL)",
        )
        .run(id, cursor);
    this.db
      .prepare("DELETE FROM clarificationCandidates WHERE cursor=?")
      .run(cursor);
  }
  remember(cursor: number, questionId: string, input: NewTask, time: number) {
    this.db
      .prepare("INSERT INTO clarificationCandidates VALUES(?,?,?,?,?)")
      .run(cursor, questionId, JSON.stringify(input), time, Date.now());
    for (const r of this.db
      .prepare(
        "SELECT cursor FROM clarificationCandidates WHERE questionTaskId=? ORDER BY githubTime DESC,cursor DESC LIMIT -1 OFFSET 8",
      )
      .all(questionId))
      this.resolveCandidate(Number(r.cursor), null);
  }
  expireCandidates(now: number) {
    for (const r of this.db
      .prepare(
        "SELECT cursor FROM clarificationCandidates WHERE receivedAt<=? ORDER BY receivedAt,cursor LIMIT 64",
      )
      .all(now - 24 * 3600000))
      this.resolveCandidate(Number(r.cursor), null);
  }
  settle(
    question: Task,
    confirmed: boolean,
    enqueue: (
      input: NewTask,
      eventKey: string,
      time: number,
      receivedAt: number,
    ) => string,
  ) {
    for (const r of this.db
      .prepare(
        "SELECT c.*,d.eventKey FROM clarificationCandidates c JOIN deliveries d ON d.cursor=c.cursor AND d.eventKey IS NOT NULL WHERE questionTaskId=? ORDER BY c.githubTime,c.cursor",
      )
      .all(question.id)) {
      const input = JSON.parse(String(r.input)) as NewTask,
        time = Number(r.githubTime);
      const m =
        confirmed && Date.now() - Number(r.receivedAt) < 24 * 3600000
          ? this.match(input, time, true)
          : undefined;
      let id = null;
      if (m?.reason === "clarification_reply" && m.questionId === question.id) {
        id = enqueue(
          { ...input, prompt: m.answer },
          String(r.eventKey),
          time,
          Number(r.receivedAt),
        );
        this.link(m, id);
      }
      this.resolveCandidate(Number(r.cursor), id);
    }
  }
  link(m: Match, id: string) {
    if (m.reason === "clarification_reply") {
      if (
        !this.db
          .prepare(
            "UPDATE clarifications SET answerTaskId=? WHERE questionTaskId=? AND answerTaskId IS NULL AND closed=0",
          )
          .run(id, m.questionId).changes
      )
        throw Error("Question already consumed");
    } else if (m.reason === "clarification_ambiguous")
      this.db
        .prepare("INSERT INTO clarificationSelections VALUES(?,?)")
        .run(id, JSON.stringify(m.choices));
  }
  fence(repositoryId: number, thread: string, time: number | undefined) {
    this.db
      .prepare(
        "UPDATE clarifications SET closed=1 WHERE thread=? AND rootTaskId IN (SELECT id FROM tasks WHERE repositoryId=? AND (? IS NULL OR githubTime IS NULL OR githubTime<=?))",
      )
      .run(thread, repositoryId, time ?? null, time ?? null);
  }
  state(id: string) {
    const q = this.db
      .prepare(
        `SELECT rootTaskId,questionTaskId,actorId AS expectedActorId,askedAt,expiresAt,answerTaskId,
      CASE WHEN answerTaskId IS NOT NULL THEN 'answered' WHEN closed=1 THEN 'closed' WHEN NOT EXISTS(SELECT 1 FROM bindings b WHERE b.installationId||':'||b.repositoryId||':'||b.deviceId||':'||b.revision=q.bindingId AND json_extract(b.declaration,'$.enabled')=1) THEN 'retired' WHEN expiresAt<=? THEN 'expired' ELSE 'waiting' END AS status
      FROM clarifications q WHERE questionTaskId=? OR answerTaskId=? ORDER BY questionTaskId=? DESC LIMIT 1`,
      )
      .get(Date.now(), id, id, id);
    return q ? { ...q } : null;
  }
  conversation(id: string) {
    const rootTaskId = String(
      this.db
        .prepare("SELECT rootTaskId FROM clarifications WHERE answerTaskId=?")
        .get(id)?.rootTaskId ?? id,
    );
    const turns = [];
    let cursor: string | null = rootTaskId;
    while (cursor && turns.length < 5) {
      const row = this.db
        .prepare(
          "SELECT id AS taskId,json_extract(source,'$.commentId') AS sourceCommentId,status,deliveryStatus,publicationReceipt FROM tasks WHERE id=?",
        )
        .get(cursor);
      if (!row) return null;
      const question = this.state(cursor);
      const isQuestion: boolean = question?.questionTaskId === cursor;
      const nextTaskId: string | null =
        isQuestion && typeof question?.answerTaskId === "string"
          ? question.answerTaskId
          : null;
      turns.push({
        ...row,
        publicationReceipt: row.publicationReceipt
          ? JSON.parse(String(row.publicationReceipt))
          : null,
        questionStatus: isQuestion ? question?.status : null,
        nextTaskId,
      });
      cursor = nextTaskId;
    }
    return { rootTaskId, turns };
  }
}
