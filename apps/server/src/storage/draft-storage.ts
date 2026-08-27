import { randomBytes, randomUUID } from "node:crypto";

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { ReportResourcePolicy } from "@yaaps/contracts";

import { validateHtmlDocument } from "../reports/html-policy.js";
import type { HtmlBlobStore } from "./blob-store.js";
import type { DatabaseSchema, DraftsTable } from "./schema.js";
import { insertAuditEvent } from "./audit-log.js";

export class DraftNotFoundError extends Error {
  constructor() {
    super("The draft was not found.");
    this.name = "DraftNotFoundError";
  }
}

export interface CreateDraftInput {
  category?: string | null;
  expiresAt: string;
  html: Uint8Array;
  ownerId: string;
  resourcePolicy?: ReportResourcePolicy;
  title?: string | null;
  uploadedByApiKeyId?: string | null;
}

export interface AddVersionInput {
  category?: string;
  draftId: string;
  expiresAt: string;
  html: Uint8Array;
  ownerId: string;
  resourcePolicy?: ReportResourcePolicy;
  title?: string;
  uploadedByApiKeyId?: string | null;
}

export interface OwnerCategory {
  category: string;
  draftCount: number;
}

export interface StoredDraftVersion {
  blobKey: string;
  byteLength: number;
  createdAt: string;
  draftId: string;
  resourcePolicy: ReportResourcePolicy;
  sha256: string;
  versionNumber: number;
  viewCount: number;
}

export interface StoredVersionMetadata {
  byteLength: number;
  createdAt: string;
  resourcePolicy: ReportResourcePolicy;
  sha256: string;
  versionNumber: number;
  viewCount: number;
}

export type StoredDraft = Selectable<DraftsTable> & {
  resourcePolicy: ReportResourcePolicy;
};

export interface PaginatedDrafts {
  items: StoredDraft[];
  total: number;
}

export interface AdminDraftRow {
  draft: StoredDraft;
  ownerDisplayName: string;
  ownerId: string;
}

export interface PaginatedAdminDrafts {
  items: AdminDraftRow[];
  total: number;
}

export interface PaginatedVersions {
  items: StoredVersionMetadata[];
  total: number;
}

export interface CleanupResult {
  deletedDrafts: number;
  reclaimedBlobs: number;
}

export type PublicReportResolution =
  | {
      expiresAt: string;
      html: Buffer;
      resourcePolicy: ReportResourcePolicy;
      status: "available";
      title: string | null;
      versionNumber: number;
    }
  | { status: "expired" }
  | { status: "unavailable" };

interface PendingPublicView {
  draftId: string;
  reject: (error: unknown) => void;
  resolve: () => void;
  versionNumber: number;
}

class ExclusiveOperations {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release: () => void = () => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class DraftStorage {
  readonly #operations = new ExclusiveOperations();
  readonly #pendingPublicViews: PendingPublicView[] = [];
  #publicViewFlushActive = false;
  #publicViewFlushScheduled = false;

  constructor(
    private readonly database: Kysely<DatabaseSchema>,
    private readonly blobs: HtmlBlobStore,
  ) {}

  async createDraft(input: CreateDraftInput): Promise<StoredDraftVersion> {
    return this.#operations.run(async () => {
      const resourcePolicy = input.resourcePolicy ?? "connected";
      validateHtmlDocument(input.html, resourcePolicy);
      const blob = await this.blobs.store(input.html);
      // A leading "-" is valid base64url but hostile to command-line tools.
      let draftId = randomBytes(24).toString("base64url");
      while (draftId.startsWith("-")) {
        draftId = randomBytes(24).toString("base64url");
      }
      const createdAt = new Date().toISOString();

      await this.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("drafts")
          .values({
            category: input.category ?? null,
            created_at: createdAt,
            expires_at: input.expiresAt,
            id: draftId,
            latest_version_number: 1,
            owner_id: input.ownerId,
            status: "enabled",
            title: input.title ?? null,
            updated_at: createdAt,
          })
          .executeTakeFirstOrThrow();
        await this.#insertVersion(transaction, {
          ...blob,
          apiKeyId: input.uploadedByApiKeyId ?? null,
          createdAt,
          draftId,
          resourcePolicy,
          versionNumber: 1,
        });
        await this.#insertAudit(transaction, {
          action: "draft.created",
          apiKeyId: input.uploadedByApiKeyId ?? null,
          metadata: { resourcePolicy, versionNumber: 1 },
          targetId: draftId,
          userId: input.ownerId,
        });
      });

      return {
        blobKey: blob.key,
        byteLength: blob.byteLength,
        createdAt,
        draftId,
        resourcePolicy,
        sha256: blob.sha256,
        versionNumber: 1,
        viewCount: 0,
      };
    });
  }

  async addVersion(input: AddVersionInput): Promise<StoredDraftVersion> {
    return this.#operations.run(async () => {
      if (!(await this.findForOwner(input.ownerId, input.draftId))) {
        throw new DraftNotFoundError();
      }
      const resourcePolicy = input.resourcePolicy ?? "connected";
      validateHtmlDocument(input.html, resourcePolicy);
      const blob = await this.blobs.store(input.html);
      const createdAt = new Date().toISOString();
      let versionNumber = 0;

      await this.database.transaction().execute(async (transaction) => {
        const draft = await transaction
          .selectFrom("drafts")
          .select("latest_version_number")
          .where("id", "=", input.draftId)
          .where("owner_id", "=", input.ownerId)
          .executeTakeFirst();
        if (!draft) {
          throw new DraftNotFoundError();
        }

        versionNumber = draft.latest_version_number + 1;
        await this.#insertVersion(transaction, {
          ...blob,
          apiKeyId: input.uploadedByApiKeyId ?? null,
          createdAt,
          draftId: input.draftId,
          resourcePolicy,
          versionNumber,
        });
        await transaction
          .updateTable("drafts")
          .set({
            ...(input.category === undefined
              ? {}
              : { category: input.category }),
            expires_at: input.expiresAt,
            latest_version_number: versionNumber,
            ...(input.title === undefined ? {} : { title: input.title }),
            updated_at: createdAt,
          })
          .where("id", "=", input.draftId)
          .where("owner_id", "=", input.ownerId)
          .executeTakeFirstOrThrow();
        await this.#insertAudit(transaction, {
          action: "draft.version_created",
          apiKeyId: input.uploadedByApiKeyId ?? null,
          metadata: { resourcePolicy, versionNumber },
          targetId: input.draftId,
          userId: input.ownerId,
        });
      });

      return {
        blobKey: blob.key,
        byteLength: blob.byteLength,
        createdAt,
        draftId: input.draftId,
        resourcePolicy,
        sha256: blob.sha256,
        versionNumber,
        viewCount: 0,
      };
    });
  }

  async findForOwner(
    ownerId: string,
    draftId: string,
  ): Promise<StoredDraft | undefined> {
    return this.database
      .selectFrom("drafts")
      .innerJoin("versions", (join) =>
        join
          .onRef("versions.draft_id", "=", "drafts.id")
          .onRef(
            "versions.version_number",
            "=",
            "drafts.latest_version_number",
          ),
      )
      .selectAll("drafts")
      .select("versions.resource_policy as resourcePolicy")
      .where("drafts.id", "=", draftId)
      .where("drafts.owner_id", "=", ownerId)
      .executeTakeFirst();
  }

  async listForOwner(
    ownerId: string,
    limit: number,
    offset: number,
    category?: string,
  ): Promise<PaginatedDrafts> {
    const [items, count] = await Promise.all([
      this.database
        .selectFrom("drafts")
        .innerJoin("versions", (join) =>
          join
            .onRef("versions.draft_id", "=", "drafts.id")
            .onRef(
              "versions.version_number",
              "=",
              "drafts.latest_version_number",
            ),
        )
        .selectAll("drafts")
        .select("versions.resource_policy as resourcePolicy")
        // The owner predicate is unconditional; the category only narrows it.
        .where("drafts.owner_id", "=", ownerId)
        .$if(category !== undefined, (builder) =>
          builder.where("drafts.category", "=", category!),
        )
        .orderBy("drafts.updated_at", "desc")
        .orderBy("drafts.id", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      this.database
        .selectFrom("drafts")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("owner_id", "=", ownerId)
        .$if(category !== undefined, (builder) =>
          builder.where("category", "=", category!),
        )
        .executeTakeFirstOrThrow(),
    ]);
    return { items, total: Number(count.count) };
  }

  async listCategoriesForOwner(ownerId: string): Promise<OwnerCategory[]> {
    const rows = await this.database
      .selectFrom("drafts")
      .select(({ fn }) => ["category", fn.countAll<number>().as("draft_count")])
      .where("owner_id", "=", ownerId)
      .where("category", "is not", null)
      .groupBy("category")
      .orderBy("category", "asc")
      .execute();
    return rows.flatMap((row) =>
      row.category === null
        ? []
        : [{ category: row.category, draftCount: Number(row.draft_count) }],
    );
  }

  async listForAdmin(
    limit: number,
    offset: number,
  ): Promise<PaginatedAdminDrafts> {
    const [items, count] = await Promise.all([
      this.database
        .selectFrom("drafts")
        .innerJoin("users", "users.id", "drafts.owner_id")
        .innerJoin("versions", (join) =>
          join
            .onRef("versions.draft_id", "=", "drafts.id")
            .onRef(
              "versions.version_number",
              "=",
              "drafts.latest_version_number",
            ),
        )
        .selectAll("drafts")
        .select("users.display_name as owner_display_name")
        .select("versions.resource_policy as resourcePolicy")
        .orderBy("drafts.updated_at", "desc")
        .orderBy("drafts.id", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      this.database
        .selectFrom("drafts")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ]);
    return {
      items: items.map(({ owner_display_name, ...draft }) => ({
        draft,
        ownerDisplayName: owner_display_name,
        ownerId: draft.owner_id,
      })),
      total: Number(count.count),
    };
  }

  async listVersionsForOwner(
    ownerId: string,
    draftId: string,
    limit: number,
    offset: number,
  ): Promise<PaginatedVersions> {
    const draft = await this.findForOwner(ownerId, draftId);
    if (!draft) {
      throw new DraftNotFoundError();
    }
    const [items, count] = await Promise.all([
      this.database
        .selectFrom("versions")
        .select([
          "byte_length",
          "created_at",
          "resource_policy",
          "sha256",
          "version_number",
          "view_count",
        ])
        .where("draft_id", "=", draftId)
        .orderBy("version_number", "desc")
        .limit(limit)
        .offset(offset)
        .execute(),
      this.database
        .selectFrom("versions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("draft_id", "=", draftId)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      items: items.map((item) => ({
        byteLength: item.byte_length,
        createdAt: item.created_at,
        resourcePolicy: item.resource_policy,
        sha256: item.sha256,
        versionNumber: item.version_number,
        viewCount: item.view_count,
      })),
      total: Number(count.count),
    };
  }

  async updateForOwner(input: {
    apiKeyId: string | null;
    category?: string | null;
    draftId: string;
    expiresAt?: string;
    ownerId: string;
    status?: DraftsTable["status"];
    title?: string | null;
  }): Promise<StoredDraft> {
    return this.#operations.run(async () => {
      const updatedAt = new Date().toISOString();
      return this.database.transaction().execute(async (transaction) => {
        const changes: {
          category?: string | null;
          expires_at?: string;
          status?: DraftsTable["status"];
          title?: string | null;
          updated_at: string;
        } = { updated_at: updatedAt };
        if (input.category !== undefined) {
          changes.category = input.category;
        }
        if (input.expiresAt !== undefined) {
          changes.expires_at = input.expiresAt;
        }
        if (input.status !== undefined) {
          changes.status = input.status;
        }
        if (input.title !== undefined) {
          changes.title = input.title;
        }
        const result = await transaction
          .updateTable("drafts")
          .set(changes)
          .where("id", "=", input.draftId)
          .where("owner_id", "=", input.ownerId)
          .returningAll()
          .executeTakeFirst();
        if (!result) {
          throw new DraftNotFoundError();
        }
        await this.#insertAudit(transaction, {
          action: "draft.updated",
          apiKeyId: input.apiKeyId,
          metadata: {
            categoryChanged: input.category !== undefined,
            expiryChanged: input.expiresAt !== undefined,
            status: input.status,
            titleChanged: input.title !== undefined,
          },
          targetId: input.draftId,
          userId: input.ownerId,
        });
        const version = await transaction
          .selectFrom("versions")
          .select("resource_policy")
          .where("draft_id", "=", result.id)
          .where("version_number", "=", result.latest_version_number)
          .executeTakeFirstOrThrow();
        return { ...result, resourcePolicy: version.resource_policy };
      });
    });
  }

  async deleteForOwner(input: {
    apiKeyId: string | null;
    draftId: string;
    ownerId: string;
  }): Promise<void> {
    await this.#operations.run(async () => {
      await this.database.transaction().execute(async (transaction) => {
        const result = await transaction
          .deleteFrom("drafts")
          .where("id", "=", input.draftId)
          .where("owner_id", "=", input.ownerId)
          .executeTakeFirst();
        if (result.numDeletedRows !== 1n) {
          throw new DraftNotFoundError();
        }
        await this.#insertAudit(transaction, {
          action: "draft.deleted",
          apiKeyId: input.apiKeyId,
          metadata: {},
          targetId: input.draftId,
          userId: input.ownerId,
        });
      });
      await this.#cleanupOrphanedBlobsWithoutLock();
    });
  }

  async updateAsAdmin(input: {
    actorUserId: string;
    draftId: string;
    status: DraftsTable["status"];
  }): Promise<StoredDraft> {
    return this.#operations.run(async () => {
      const updatedAt = new Date().toISOString();
      return this.database.transaction().execute(async (transaction) => {
        const result = await transaction
          .updateTable("drafts")
          .set({ status: input.status, updated_at: updatedAt })
          .where("id", "=", input.draftId)
          .returningAll()
          .executeTakeFirst();
        if (!result) {
          throw new DraftNotFoundError();
        }
        await this.#insertAudit(transaction, {
          action: "draft.admin_updated",
          apiKeyId: null,
          metadata: { status: input.status },
          targetId: input.draftId,
          userId: input.actorUserId,
        });
        const version = await transaction
          .selectFrom("versions")
          .select("resource_policy")
          .where("draft_id", "=", result.id)
          .where("version_number", "=", result.latest_version_number)
          .executeTakeFirstOrThrow();
        return { ...result, resourcePolicy: version.resource_policy };
      });
    });
  }

  async deleteAsAdmin(input: {
    actorUserId: string;
    draftId: string;
  }): Promise<void> {
    await this.#operations.run(async () => {
      await this.database.transaction().execute(async (transaction) => {
        const result = await transaction
          .deleteFrom("drafts")
          .where("id", "=", input.draftId)
          .executeTakeFirst();
        if (result.numDeletedRows !== 1n) {
          throw new DraftNotFoundError();
        }
        await this.#insertAudit(transaction, {
          action: "draft.admin_deleted",
          apiKeyId: null,
          metadata: {},
          targetId: input.draftId,
          userId: input.actorUserId,
        });
      });
      await this.#cleanupOrphanedBlobsWithoutLock();
    });
  }

  async resolvePublic(
    draftId: string,
    requestedVersion?: number,
    now = new Date(),
  ): Promise<PublicReportResolution> {
    const draft = await this.database
      .selectFrom("drafts")
      .select(["expires_at", "latest_version_number", "status", "title"])
      .where("id", "=", draftId)
      .executeTakeFirst();

    if (!draft || draft.status !== "enabled") {
      return { status: "unavailable" };
    }
    if (draft.expires_at <= now.toISOString()) {
      return { status: "expired" };
    }

    const versionNumber = requestedVersion ?? draft.latest_version_number;
    const version = await this.database
      .selectFrom("drafts")
      .innerJoin("versions", (join) =>
        join.onRef("versions.draft_id", "=", "drafts.id"),
      )
      .select(["versions.blob_key", "versions.resource_policy"])
      .where("drafts.id", "=", draftId)
      .where("versions.version_number", "=", versionNumber)
      .executeTakeFirst();

    if (!version) {
      return { status: "unavailable" };
    }
    return {
      expiresAt: draft.expires_at,
      html: await this.blobs.read(version.blob_key),
      resourcePolicy: version.resource_policy,
      status: "available",
      title: draft.title,
      versionNumber,
    };
  }

  recordPublicView(draftId: string, versionNumber: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#pendingPublicViews.push({
        draftId,
        reject,
        resolve,
        versionNumber,
      });
      this.#schedulePublicViewFlush();
    });
  }

  #schedulePublicViewFlush(): void {
    if (this.#publicViewFlushActive || this.#publicViewFlushScheduled) {
      return;
    }
    this.#publicViewFlushScheduled = true;
    setImmediate(() => {
      this.#publicViewFlushScheduled = false;
      this.#publicViewFlushActive = true;
      void this.#flushPublicViews().finally(() => {
        this.#publicViewFlushActive = false;
        if (this.#pendingPublicViews.length > 0) {
          this.#schedulePublicViewFlush();
        }
      });
    });
  }

  async #flushPublicViews(): Promise<void> {
    const pending = this.#pendingPublicViews.splice(0);
    const grouped = new Map<
      string,
      {
        count: number;
        draftId: string;
        versionNumber: number;
        views: PendingPublicView[];
      }
    >();
    for (const view of pending) {
      const key = `${view.draftId}:${view.versionNumber}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
        existing.views.push(view);
      } else {
        grouped.set(key, {
          count: 1,
          draftId: view.draftId,
          versionNumber: view.versionNumber,
          views: [view],
        });
      }
    }

    for (const group of grouped.values()) {
      try {
        // Migration 006 synchronizes the draft total in the same statement.
        const version = await this.database
          .updateTable("versions")
          .set({ view_count: sql<number>`view_count + ${group.count}` })
          .where("draft_id", "=", group.draftId)
          .where("version_number", "=", group.versionNumber)
          .executeTakeFirst();
        if (version.numUpdatedRows !== 1n) {
          throw new DraftNotFoundError();
        }
        for (const view of group.views) {
          view.resolve();
        }
      } catch (error) {
        for (const view of group.views) {
          view.reject(error);
        }
      }
    }
  }

  async cleanupOrphanedBlobs(): Promise<number> {
    return this.#operations.run(() => this.#cleanupOrphanedBlobsWithoutLock());
  }

  async cleanupExpired(now = new Date()): Promise<CleanupResult> {
    return this.#operations.run(async () => {
      const expired = await this.database
        .selectFrom("drafts")
        .select("id")
        .where("expires_at", "<=", now.toISOString())
        .orderBy("id")
        .execute();
      if (expired.length === 0) {
        return { deletedDrafts: 0, reclaimedBlobs: 0 };
      }
      await this.database.transaction().execute(async (transaction) => {
        const ids = expired.map((draft) => draft.id);
        await transaction.deleteFrom("drafts").where("id", "in", ids).execute();
        for (const draftId of ids) {
          await this.#insertAudit(transaction, {
            action: "draft.expired",
            apiKeyId: null,
            metadata: {},
            targetId: draftId,
            userId: null,
          });
        }
      });
      return {
        deletedDrafts: expired.length,
        reclaimedBlobs: await this.#cleanupOrphanedBlobsWithoutLock(),
      };
    });
  }

  async #cleanupOrphanedBlobsWithoutLock(): Promise<number> {
    const references = new Set(
      (
        await this.database
          .selectFrom("versions")
          .select("blob_key")
          .distinct()
          .execute()
      ).map((row) => row.blob_key),
    );
    const keys = await this.blobs.listKeys();
    const orphaned = keys.filter((key) => !references.has(key));
    await Promise.all(orphaned.map((key) => this.blobs.remove(key)));
    return orphaned.length;
  }

  async #insertAudit(
    transaction: Transaction<DatabaseSchema>,
    input: {
      action: string;
      apiKeyId: string | null;
      metadata: Record<string, unknown>;
      targetId: string;
      userId: string | null;
    },
  ): Promise<void> {
    await insertAuditEvent(transaction, {
      action: input.action,
      actorApiKeyId: input.apiKeyId,
      actorUserId: input.userId,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
      targetId: input.targetId,
      targetType: "draft",
    });
  }

  async #insertVersion(
    transaction: Transaction<DatabaseSchema>,
    input: {
      apiKeyId: string | null;
      byteLength: number;
      createdAt: string;
      draftId: string;
      key: string;
      sha256: string;
      resourcePolicy: ReportResourcePolicy;
      versionNumber: number;
    },
  ): Promise<void> {
    await transaction
      .insertInto("versions")
      .values({
        blob_key: input.key,
        byte_length: input.byteLength,
        created_at: input.createdAt,
        draft_id: input.draftId,
        id: randomUUID(),
        resource_policy: input.resourcePolicy,
        sha256: input.sha256,
        uploaded_by_api_key_id: input.apiKeyId,
        version_number: input.versionNumber,
      })
      .executeTakeFirstOrThrow();
  }
}
