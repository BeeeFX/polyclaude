// Minimal UI-side mirrors of the IPC payloads. Kept local (not imported from the
// Node core) so the renderer's bundler never has to resolve Node/NodeNext modules.

export interface AccountUsage {
  fiveHourPct?: number | null;
  fiveHourResetsAt?: number;
  sevenDayPct?: number | null;
  sevenDayResetsAt?: number;
  fetchedAt: number;
  error?: string;
  stale?: boolean;
}

export interface AccountMeta {
  label: string;
  email?: string;
  fullName?: string;
  subscriptionType?: string;
  orgType?: string;
  orgName?: string;
  usage?: AccountUsage;
}

export interface Settings {
  name: string;
  model: string;
  effort: "" | "low" | "medium" | "high" | "max";
  thinking: boolean;
  thinkingBudget: number;
  autoSwitch: boolean;
  switchOrder: string[];
}

export interface Conversation {
  sessionId: string;
  title: string;
  cwd?: string;
  project: string;
  mtime: number;
  messages: number;
}

export interface AuthStatus {
  loggedIn: boolean;
  email?: string;
  subscriptionType?: string;
}

export type Result = { ok: true } | { ok: false; error: string };

export interface PolyApi {
  app: { info(): Promise<{ version: string; platform: string }> };
  auth: { status(): Promise<AuthStatus | null> };
  accounts: {
    list(): Promise<AccountMeta[]>;
    active(): Promise<string | null>;
    switch(label: string): Promise<Result>;
    rename(oldLabel: string, newLabel: string): Promise<Result>;
    remove(label: string): Promise<Result>;
  };
  usage: {
    active(): Promise<AccountUsage | null>;
    all(): Promise<Record<string, AccountUsage>>;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: Partial<Settings>): Promise<Settings>;
  };
  conversations: { list(limit?: number): Promise<Conversation[]> };
  claude: { launch(cwd?: string): Promise<Result> };
  terminal: {
    available(): Promise<boolean>;
    start(opts: TermStartOpts): Promise<{ ok: true; id: number } | { ok: false; error: string }>;
    write(id: number, data: string): void;
    resize(id: number, cols: number, rows: number): void;
    kill(id: number): void;
    onData(cb: (p: { id: number; data: string }) => void): () => void;
    onExit(cb: (p: { id: number; exitCode: number }) => void): () => void;
  };
}

export interface TermStartOpts {
  cols?: number;
  rows?: number;
  cwd?: string;
  resume?: boolean;
  resumeId?: string;
}
