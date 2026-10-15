// Phones that "Stay connected" (the Android app's StayConnectedService) keep
// one open GET /api/phone/stream, and every push to their member is written
// down it too, next to Firebase. Kept in this server process's memory: a
// connection belongs to the process that answered it, and OurHome runs as one
// process. On globalThis so every route bundle (and a dev reload) shares one.

/** One open stream: whose phone, and how to write a message down it. */
export interface StreamConnection {
  householdId: string;
  userId: string;
  installId: string;
  send: (data: Record<string, string>) => void;
}

const globalHub = globalThis as unknown as { __ourhomeStreams?: Set<StreamConnection> };
const connections = (globalHub.__ourhomeStreams ??= new Set<StreamConnection>());

/** Adds a connection; the returned function removes it (the phone went away). */
export function addStream(conn: StreamConnection): () => void {
  connections.add(conn);
  return () => {
    connections.delete(conn);
  };
}

/**
 * Writes [data] to every open stream of these members. Returns how many
 * streams took it; a stream that throws (closed mid-write) is dropped.
 */
export function deliverToStreams(householdId: string, userIds: Iterable<string>, data: Record<string, string>): number {
  const wanted = new Set(userIds);
  let delivered = 0;
  for (const conn of [...connections]) {
    if (conn.householdId !== householdId || !wanted.has(conn.userId)) continue;
    try {
      conn.send(data);
      delivered++;
    } catch {
      connections.delete(conn);
    }
  }
  return delivered;
}

/** Whether any phone in the household is connected (then pushes are worth sending without Firebase). */
export function hasStreams(householdId: string): boolean {
  for (const conn of connections) if (conn.householdId === householdId) return true;
  return false;
}

/** Whether this member has a phone connected right now. */
export function isStreamConnected(householdId: string, userId: string): boolean {
  for (const conn of connections) if (conn.householdId === householdId && conn.userId === userId) return true;
  return false;
}

/** The installs connected right now, for the phone lines ("connected"). */
export function connectedInstalls(householdId: string): Set<string> {
  const out = new Set<string>();
  for (const conn of connections) if (conn.householdId === householdId) out.add(conn.installId);
  return out;
}

/** Tests only: forget every connection. */
export function clearStreams(): void {
  connections.clear();
}
