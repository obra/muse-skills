// The Space's viewer context in the browser: who is looking at the Space,
// who else has it open, and when someone changes its data.
//
// It is read from the Muse that serves the Space (`./_viewer`), the owner's
// own Muse or, for a connection, the owner's Muse through theirs, so every
// page sees the same people. Identity comes from that Muse's authentication,
// never from this page. Pages that use it poll while visible; that also keeps
// this viewer present for the others.

import { useSyncExternalStore } from "react";

/** What a person may do in the Space: read it, run its actions, or edit it. */
export type SpaceRole = "view" | "use" | "edit";

export interface SpacePerson {
  /** The person's Muse ID, stable across visits. Matches `ctx.viewer.museId`. */
  readonly id: string;
  readonly name: string | null;
  readonly role: SpaceRole;
  /** The Space's owner. Matches `ctx.viewer.isOwner` in actions. */
  readonly owner: boolean;
}

export interface SpacePresentPerson extends SpacePerson {
  /** When this visit started, in epoch milliseconds. */
  readonly sinceMs: number;
}

export interface SpaceViewer {
  readonly you: SpacePerson;
  /** The owner, also when they are not here. */
  readonly host: SpacePerson;
  /** Everyone with the Space open now, you included, longest here first. */
  readonly present: readonly SpacePresentPerson[];
}

export type SpaceViewerEvent =
  | { readonly type: "join"; readonly person: SpacePresentPerson }
  | { readonly type: "leave"; readonly person: SpacePresentPerson }
  /**
   * Someone else's action changed the Space's data. `by` is their `id`, or
   * null when no person here acted, such as the Space's agent or a schedule.
   * The SDK already refetches the page's queries.
   */
  | { readonly type: "change"; readonly by: string | null; readonly atMs: number };

interface WirePerson {
  id: string;
  name: string | null;
  role: SpaceRole;
  owner: boolean;
}

interface WireViewer {
  you: WirePerson;
  host: WirePerson;
  present: Array<WirePerson & { since_ms: number }>;
  changes: Array<{ by: string | null; at_ms: number; call_id: string | null }>;
  /** Changes may have been missed: refetch, but nobody is named for it. */
  resync?: boolean;
  cursor: string;
}

/** The serving Muse wraps every answer as `{ok, result}` or `{ok, error}`. */
interface WireEnvelope {
  ok?: unknown;
  result?: unknown;
  error?: { code?: unknown };
}

const POLL_MS = 15_000;
const MAX_IDLE_POLL_MS = 300_000;
const UNAVAILABLE_STATUSES = new Set([401, 403, 404]);

export interface SpaceViewerStoreHooks {
  /** True for an `actionCallId` this page sent or already refreshed for. */
  isKnownCall(callId: string): boolean;
  /** Someone else changed the data: refetch the page's queries. */
  refresh(): void;
}

export interface SpaceViewerStore {
  get(): Promise<SpaceViewer | null>;
  subscribe(listener: (event?: SpaceViewerEvent) => void): () => void;
  current(): SpaceViewer | null;
}

export function createSpaceViewerStore(hooks: SpaceViewerStoreHooks): SpaceViewerStore {
  let snapshot: SpaceViewer | null = null;
  let unavailable = false;
  let idlePollMs: number | null = null;
  let cursor: string | null = null;
  let loaded = false;
  let recovering = false;
  let inFlight: Promise<SpaceViewer | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<(event?: SpaceViewerEvent) => void>();

  const emit = (event?: SpaceViewerEvent) => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  };

  const visible = () =>
    typeof document === "undefined" || document.visibilityState !== "hidden";

  const schedule = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (unavailable || listeners.size === 0 || !visible()) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void read().finally(schedule);
    }, idlePollMs ?? POLL_MS);
  };

  const apply = (wire: WireViewer) => {
    idlePollMs = null;
    loaded = true;
    const present = wire.present.map(
      ({ since_ms, ...person }): SpacePresentPerson => ({ ...person, sinceMs: since_ms }),
    );
    const next: SpaceViewer = { you: wire.you, host: wire.host, present };
    const previous = snapshot;
    const same = previous != null && JSON.stringify(previous) === JSON.stringify(next);
    if (!same) {
      snapshot = next;
    }
    cursor = wire.cursor;
    const events: SpaceViewerEvent[] = [];
    if (previous != null) {
      const before = new Map(previous.present.map((person) => [person.id, person]));
      const after = new Map(present.map((person) => [person.id, person]));
      for (const person of present) {
        if (!before.has(person.id)) events.push({ type: "join", person });
      }
      for (const person of previous.present) {
        if (!after.has(person.id)) events.push({ type: "leave", person });
      }
    }
    let changed = wire.resync === true || recovering;
    recovering = false;
    for (const change of wire.changes) {
      if (change.call_id != null && hooks.isKnownCall(change.call_id)) {
        continue;
      }
      changed = true;
      events.push({ type: "change", by: change.by, atMs: change.at_ms });
    }
    if (changed) {
      hooks.refresh();
    }
    if (events.length === 0 && !same) {
      emit();
    }
    for (const event of events) {
      emit(event);
    }
  };

  const markUnavailable = (): null => {
    unavailable = true;
    snapshot = null;
    emit();
    return null;
  };

  const pause = (): null => {
    idlePollMs = Math.min((idlePollMs ?? POLL_MS) * 2, MAX_IDLE_POLL_MS);
    cursor = null;
    recovering = loaded;
    if (snapshot != null) {
      snapshot = null;
      emit();
    }
    return null;
  };

  const fetchViewer = async (): Promise<SpaceViewer | null> => {
    const base = new URL(globalThis.location?.href ?? "https://hatch.invalid/");
    base.hash = "";
    base.search = "";
    const url = new URL(
      cursor == null ? "./_viewer" : `./_viewer/${encodeURIComponent(cursor)}`,
      base,
    );
    let response: Response;
    try {
      response = await globalThis.fetch(url.toString(), {
        headers: { accept: "application/json" },
      });
    } catch {
      return snapshot;
    }
    const body = (await response.json().catch(() => null)) as WireEnvelope | null;
    if (response.ok && body?.ok !== true) {
      return markUnavailable();
    }
    if (!response.ok) {
      const code = body?.error?.code;
      if (typeof code !== "string") {
        return snapshot;
      }
      if (UNAVAILABLE_STATUSES.has(response.status)) {
        return loaded ? pause() : markUnavailable();
      }
      if (code === "peer_operation_unavailable") {
        return pause();
      }
      return snapshot;
    }
    apply(body?.result as WireViewer);
    return snapshot;
  };

  const read = (): Promise<SpaceViewer | null> => {
    if (unavailable) {
      return Promise.resolve(null);
    }
    inFlight ??= fetchViewer()
      .catch(() => snapshot)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (listeners.size > 0 && visible()) {
        void read().finally(schedule);
      } else {
        schedule();
      }
    });
  }

  return {
    get: read,
    current: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void read().finally(schedule);
      }
      return () => {
        listeners.delete(listener);
        schedule();
      };
    },
  };
}

/** React binding: the current viewer context, or null until it loads or when the Space has none. */
export function useSpaceViewerFrom(store: SpaceViewerStore): SpaceViewer | null {
  return useSyncExternalStore(
    (onChange) => store.subscribe(() => onChange()),
    store.current,
    () => null,
  );
}
