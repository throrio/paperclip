import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));
vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

// ─── Route-level tests (Layer 2: DELETE /execution-lock) ─────────────────────
// These use mocked services and do not need embedded Postgres.

const mockReleaseExecutionLock = vi.hoisted(() => vi.fn(async () => ({ id: "issue-1" })));
const mockGetById = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({}),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({ get: vi.fn(), listCompanyIds: vi.fn() }),
  issueApprovalService: () => ({}),
  issueService: () => ({
    getById: mockGetById,
    // The router's :id param middleware resolves human identifiers (e.g. "AUSA-2010")
    // via getByIdentifier. The "issue-1" fixture matches that same /^[A-Z]+-\d+$/i shape,
    // so this must exist; returning null falls back to treating the raw id as a UUID.
    getByIdentifier: vi.fn(async () => null),
    getAncestors: vi.fn(async () => []),
    getComment: vi.fn(async () => null),
    getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
    getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
    listWakeableBlockedDependents: vi.fn(async () => []),
    getWakeableParentAfterChildCompletion: vi.fn(async () => null),
    findMentionedAgents: vi.fn(async () => []),
    releaseExecutionLock: mockReleaseExecutionLock,
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("DELETE /issues/:id/execution-lock (Layer 2)", () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await createApp();
  });

  afterEach(() => {
    vi.resetAllMocks();
    mockGetById.mockReset();
    mockReleaseExecutionLock.mockReset();
  });

  it("returns 404 when issue does not exist", async () => {
    mockGetById.mockResolvedValue(null);
    const res = await request(app).delete("/api/issues/missing-id/execution-lock");
    expect(res.status).toBe(404);
  });

  it("returns 204 and releases the lock for a board user", async () => {
    mockGetById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-abc",
    });
    mockReleaseExecutionLock.mockResolvedValue({ id: "issue-1" });

    const res = await request(app).delete("/api/issues/issue-1/execution-lock");
    if (res.status !== 204) {
      console.error("Unexpected response body:", JSON.stringify(res.body));
    }
    expect(res.status).toBe(204);
    expect(mockReleaseExecutionLock).toHaveBeenCalledWith("issue-1");
  });

  it("returns 204 even when issue has no executionRunId (idempotent)", async () => {
    mockGetById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: null,
    });
    mockReleaseExecutionLock.mockResolvedValue({ id: "issue-1" });

    const res = await request(app).delete("/api/issues/issue-1/execution-lock");
    expect(res.status).toBe(204);
  });
});

// ─── Service-level tests (Layers 1 & 3) with embedded Postgres ───────────────

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stale execution lock integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("stale execution lock — service-level (Layers 1 & 3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(agentRuntimeState);
      try {
        await db.delete(agents);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(opts: {
    runStatus: "running" | "timed_out" | "failed" | "cancelled" | "error";
    runUpdatedAt?: Date;
    issueStatus?: "todo" | "in_progress" | "blocked";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleLockRunId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: staleLockRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: opts.runStatus,
      contextSnapshot: { issueId },
      startedAt: new Date(now.getTime() - 20 * 60 * 1000),
      updatedAt: opts.runUpdatedAt ?? new Date(now.getTime() - 15 * 60 * 1000),
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test issue with stale lock",
      status: opts.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: staleLockRunId,
      executionRunId: staleLockRunId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, staleLockRunId, issueId, issuePrefix };
  }

  // ── Layer 1: Checkout auto-resolve ─────────────────────────────────────────
  // We pass checkoutRunId=null (no new run record needed) — the staleness
  // detection clears both executionRunId and checkoutRunId so the checkout
  // succeeds immediately without requiring a new heartbeat run in the DB.

  it("Layer 1: checkout succeeds when locked run is timed_out", async () => {
    const { agentId, issueId } = await seedFixture({ runStatus: "timed_out" });
    const svc = issueService(db);

    const result = await svc.checkout(issueId, agentId, ["in_progress", "todo", "blocked"], null);

    expect(result.id).toBe(issueId);
    expect(result.executionRunId).toBeNull();
    expect(result.checkoutRunId).toBeNull();
  });

  it("Layer 1: checkout succeeds when locked run is failed", async () => {
    const { agentId, issueId } = await seedFixture({ runStatus: "failed" });
    const svc = issueService(db);

    const result = await svc.checkout(issueId, agentId, ["in_progress", "todo", "blocked"], null);

    expect(result.id).toBe(issueId);
    expect(result.status).toBe("in_progress");
  });

  it("Layer 1: checkout succeeds when locked run is running but updatedAt > 10 min ago (stale-running)", async () => {
    const staleUpdatedAt = new Date(Date.now() - 12 * 60 * 1000); // 12 min ago
    const { agentId, issueId } = await seedFixture({
      runStatus: "running",
      runUpdatedAt: staleUpdatedAt,
    });
    const svc = issueService(db);

    const result = await svc.checkout(issueId, agentId, ["in_progress", "todo", "blocked"], null);

    expect(result.id).toBe(issueId);
    expect(result.executionRunId).toBeNull();
  });

  it("Layer 1: checkout throws conflict when locked run is live (running, recent heartbeat)", async () => {
    const recentUpdatedAt = new Date(Date.now() - 30 * 1000); // 30 sec ago
    const { companyId, agentId, issueId } = await seedFixture({
      runStatus: "running",
      runUpdatedAt: recentUpdatedAt,
    });
    const differentAgentId = randomUUID();

    // A different agent in the same company tries to take the issue.
    await db.insert(agents).values({
      id: differentAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const svc = issueService(db);

    await expect(
      svc.checkout(issueId, differentAgentId, ["in_progress", "todo", "blocked"], null),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ── Layer 3: Background watchdog ───────────────────────────────────────────

  it("Layer 3: sweepStaleExecutionLocks clears lock held by timed_out run and resets status to todo", async () => {
    const { issueId } = await seedFixture({ runStatus: "timed_out", issueStatus: "in_progress" });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepStaleExecutionLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const row = await db
      .select({ executionRunId: issues.executionRunId, status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(row?.executionRunId).toBeNull();
    expect(row?.status).toBe("todo");
  });

  it("Layer 3: sweepStaleExecutionLocks clears lock held by stale running run", async () => {
    const staleUpdatedAt = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
    const { issueId } = await seedFixture({ runStatus: "running", runUpdatedAt: staleUpdatedAt });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepStaleExecutionLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toContain(issueId);
  });

  it("Layer 3: sweepStaleExecutionLocks does NOT clear lock held by live running run", async () => {
    const recentUpdatedAt = new Date(Date.now() - 30 * 1000); // 30 sec ago
    const { issueId } = await seedFixture({ runStatus: "running", runUpdatedAt: recentUpdatedAt });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepStaleExecutionLocks();

    expect(result.cleared).toBe(0);

    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(row?.executionRunId).not.toBeNull();
  });

  it("Layer 3: sweepStaleExecutionLocks preserves non-in_progress status when clearing (e.g. blocked)", async () => {
    const { issueId } = await seedFixture({ runStatus: "timed_out", issueStatus: "blocked" });
    const heartbeat = heartbeatService(db);

    await heartbeat.sweepStaleExecutionLocks();

    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(row?.status).toBe("blocked");
  });
});
