type Statement = {
  bind(...values: unknown[]): Statement;
  run(): Promise<unknown>;
  first<T>(): Promise<T | null>;
};

export type SharedDatabase = { prepare(sql: string): Statement };

export class SharedStateUnavailable extends Error {
  constructor() {
    super("This app is being updated or unshared. Please try again shortly.");
  }
}

// Protocol 1 is provisioned by space-control-plane. An interrupted invocation
// stays recorded: neither unshare nor deployment may guess that its effects
// have stopped merely because a deadline elapsed.
export async function admitSharedAction(db: SharedDatabase): Promise<() => Promise<void>> {
  const id = crypto.randomUUID();
  const release = async () => {
    await db.prepare("DELETE FROM __hatch_shared_invocations WHERE id = ?").bind(id).run();
  };
  let admitted: { id: string } | null;
  try {
    admitted = await db.prepare(`INSERT INTO __hatch_shared_invocations (id, kind, started_at_ms)
      SELECT ?, 'action', ? FROM __hatch_shared_state
      WHERE id = 1 AND version = 1 AND accepting = 1
        AND NOT EXISTS (SELECT 1 FROM __hatch_shared_invocations WHERE kind = 'deploy')
      RETURNING id`).bind(id, Date.now()).first<{ id: string }>();
  } catch (error) {
    // Admission may have committed before its reply was lost. The handler has
    // not started, so removing this exact invocation cannot release live work.
    await release();
    throw error;
  }
  if (!admitted) throw new SharedStateUnavailable();
  return release;
}

export async function sharedStateAvailable(db: SharedDatabase): Promise<boolean> {
  const state = await db.prepare(`SELECT accepting FROM __hatch_shared_state
    WHERE id = 1 AND version = 1 AND accepting = 1
      AND NOT EXISTS (SELECT 1 FROM __hatch_shared_invocations WHERE kind = 'deploy')`)
    .first<{ accepting: number }>();
  return state?.accepting === 1;
}
