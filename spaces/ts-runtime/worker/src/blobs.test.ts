import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createClient } from "@libsql/client";
import { createBlobClient } from "./blobs";

const tempDirs: string[] = [];

async function makeClient() {
  const spaceDir = await mkdtemp(join(tmpdir(), "hatch-space-blobs-"));
  tempDirs.push(spaceDir);
  return {
    blobs: createBlobClient({
      spaceDir,
    }),
    spaceDir,
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("createBlobClient", () => {
  // Untrusted Space code chooses blob keys; a dot-path key would write outside
  // the space dir. The guard is the sandbox boundary for the blob store.
  test("rejects path traversal in blob keys", async () => {
    const { blobs } = await makeClient();

    await expect(blobs.put("../escape", "x")).rejects.toThrow("dot path");
  });

  // Migration dual-read: a pre-decoupling blob (object at objects/<key>, row
  // with null object_id) must still be served and deleted from the legacy path.
  test("delete handles legacy null-object_id rows (objects/<key>)", async () => {
    const { blobs, spaceDir } = await makeClient();
    const key = "images/legacy.png";
    // Warm the index so openIndex creates the table (+ object_id column) before
    // we hand-write a legacy-shaped row directly.
    await blobs.head(key);
    const legacyPath = join(spaceDir, "blobs", "objects", "images", "legacy.png");
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, Buffer.from([9]));

    const index = createClient({
      url: `file:${join(spaceDir, "blobs", "index.sqlite")}`,
    });
    try {
      await index.execute({
        sql: `INSERT INTO blobs (key, content_type, size_bytes, etag, visibility, created_at_ms, updated_at_ms, object_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        args: [key, "image/png", 1, "etag-legacy", "public", 1, 1],
      });
    } finally {
      index.close();
    }

    expect((await blobs.head(key))?.key).toBe(key);
    await blobs.delete(key);
    expect(await blobs.head(key)).toBeNull();
    await expect(stat(legacyPath)).rejects.toThrow(); // legacy object removed
  });
});
