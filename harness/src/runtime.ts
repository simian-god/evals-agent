// The swap point between the subject's module-level singletons and the current
// case's world.
//
// The subject does `export const db = createClient(...)` at module load, so the
// reference it captures must outlive a single case. mock.module() therefore
// installs this PROXY once; each case rebinds what it points at. That is what
// lets one process run a whole suite with a fresh world per case.
let currentDb: { from(table: string): any; rpc(name: string, args?: any): any } | null = null;

export function bindWorld(db: typeof currentDb): void {
  currentDb = db;
}

function live() {
  if (!currentDb) {
    throw new Error("[evals] the subject touched the database outside a case session");
  }
  return currentDb;
}

/** The object handed to the subject in place of its supabase client. */
export const dbProxy = {
  from(table: string) {
    return live().from(table);
  },
  rpc(name: string, args?: any) {
    return live().rpc(name, args);
  },
};
