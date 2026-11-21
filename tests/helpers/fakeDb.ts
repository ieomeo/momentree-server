// supabase-js의 조회 문법 중 서버가 쓰는 부분만 흉내 낸 메모리 DB입니다.
// (실제 PostgreSQL이 아니므로 SQL 자체는 supabase/schema.sql로 따로 확인해야 해요.)
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type DbError = { code: string; message: string } | null;

const UNIQUE: Record<string, string[][]> = {
  users: [['id'], ['email'], ['nickname_key']],
  identities: [['user_id']],
  subscriptions: [['subscriber_id', 'author_id']],
  blocks: [['blocker_id', 'blocked_id']],
  posts: [['id']],
  post_likes: [['post_id', 'user_id']],
  comments: [['id']],
  email_codes: [['email']],
  email_verified: [['email']],
  withdrawn_emails: [['email']],
  blocked_emails: [['email']],
  daily_notes: [['user_id', 'note_date']],
};

// 부모 행이 지워질 때 자식 행을 어떻게 처리할지 (PostgreSQL의 ON DELETE 규칙)
const FKS: { table: string; col: string; ref: string; onDelete: 'cascade' | 'set null' }[] = [
  { table: 'identities', col: 'user_id', ref: 'users', onDelete: 'cascade' },
  { table: 'subscriptions', col: 'subscriber_id', ref: 'users', onDelete: 'cascade' },
  { table: 'subscriptions', col: 'author_id', ref: 'users', onDelete: 'cascade' },
  { table: 'blocks', col: 'blocker_id', ref: 'users', onDelete: 'cascade' },
  { table: 'blocks', col: 'blocked_id', ref: 'users', onDelete: 'cascade' },
  { table: 'posts', col: 'author_id', ref: 'users', onDelete: 'set null' },
  { table: 'post_likes', col: 'post_id', ref: 'posts', onDelete: 'cascade' },
  { table: 'post_likes', col: 'user_id', ref: 'users', onDelete: 'cascade' },
  { table: 'comments', col: 'post_id', ref: 'posts', onDelete: 'cascade' },
  { table: 'comments', col: 'author_id', ref: 'users', onDelete: 'set null' },
  { table: 'reports', col: 'reporter_id', ref: 'users', onDelete: 'set null' },
  { table: 'crisis_alerts', col: 'post_id', ref: 'posts', onDelete: 'set null' },
  { table: 'leaf_logs', col: 'user_id', ref: 'users', onDelete: 'cascade' },
  { table: 'notifications', col: 'user_id', ref: 'users', onDelete: 'cascade' },
  { table: 'daily_notes', col: 'user_id', ref: 'users', onDelete: 'cascade' },
];

export function createFakeDb() {
  const tables: Record<string, Row[]> = {};
  const rows = (name: string): Row[] => (tables[name] ??= []);
  const copy = <T,>(value: T): T => structuredClone(value);

  function violates(table: string, candidate: Row, ignore?: Row): boolean {
    return (UNIQUE[table] ?? []).some((cols) =>
      rows(table).some((r) => r !== ignore && cols.every((c) => r[c] !== undefined && r[c] === candidate[c])),
    );
  }

  function removeRows(table: string, doomed: Row[]): void {
    if (doomed.length === 0) return;
    tables[table] = rows(table).filter((r) => !doomed.includes(r));
    for (const fk of FKS.filter((f) => f.ref === table)) {
      const ids = new Set(doomed.map((d) => d.id));
      const children = rows(fk.table).filter((c) => ids.has(c[fk.col]));
      if (fk.onDelete === 'cascade') removeRows(fk.table, children);
      else children.forEach((c) => (c[fk.col] = null));
    }
  }

  class Query implements PromiseLike<{ data: any; error: DbError }> {
    private filters: ((r: Row) => boolean)[] = [];
    private orderBy: { col: string; asc: boolean } | null = null;
    private max: number | null = null;
    private mode: 'many' | 'single' | 'maybe' = 'many';
    private columns: string | null = null;
    private returning = false;

    constructor(
      private table: string,
      private op: 'select' | 'insert' | 'update' | 'delete' | 'upsert',
      private payload?: Row | Row[],
      private onConflict?: string,
    ) {}

    select(columns = '*') {
      if (this.op === 'select') this.columns = columns === '*' ? null : columns;
      else this.returning = true;
      return this;
    }
    eq(col: string, value: unknown) { this.filters.push((r) => r[col] === value); return this; }
    neq(col: string, value: unknown) { this.filters.push((r) => r[col] !== value); return this; }
    lt(col: string, value: unknown) { this.filters.push((r) => r[col] !== undefined && r[col] !== null && r[col] < (value as never)); return this; }
    in(col: string, values: unknown[]) { this.filters.push((r) => values.includes(r[col])); return this; }
    order(col: string, opts?: { ascending?: boolean }) { this.orderBy = { col, asc: opts?.ascending ?? true }; return this; }
    limit(n: number) { this.max = n; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }

    then<A, B>(
      onfulfilled?: ((value: { data: any; error: DbError }) => A | PromiseLike<A>) | null,
      onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
    ): PromiseLike<A | B> {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    }

    private run(): { data: any; error: DbError } {
      const matches = () => rows(this.table).filter((r) => this.filters.every((f) => f(r)));
      let result: Row[];

      if (this.op === 'select') {
        result = matches();
        if (this.orderBy) {
          const { col, asc } = this.orderBy;
          result = [...result].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (this.max !== null) result = result.slice(0, this.max);
      } else if (this.op === 'insert' || this.op === 'upsert') {
        const input = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map(copy);
        result = [];
        for (const item of input) {
          if (this.op === 'upsert') {
            const keys = (this.onConflict ?? '').split(',');
            const existing = rows(this.table).find((r) => keys.every((k) => r[k] === item[k]));
            if (existing) {
              Object.assign(existing, item);
              result.push(existing);
              continue;
            }
          }
          if (violates(this.table, item)) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${this.table})` } };
          }
          rows(this.table).push(item);
          result.push(item);
        }
      } else if (this.op === 'update') {
        result = matches();
        for (const r of result) {
          const next = { ...r, ...(this.payload as Row) };
          if (violates(this.table, next, r)) {
            return { data: null, error: { code: '23505', message: `duplicate key value violates unique constraint (${this.table})` } };
          }
          Object.assign(r, this.payload);
        }
      } else {
        result = matches();
        removeRows(this.table, result);
      }

      let data: any = result.map(copy);
      if (this.columns) {
        const wanted = this.columns.split(',').map((c) => c.trim());
        data = data.map((r: Row) => Object.fromEntries(wanted.map((c) => [c, r[c]])));
      }
      const wantsRows = this.op === 'select' || this.returning || this.mode !== 'many';
      if (!wantsRows) return { data: null, error: null };
      if (this.mode === 'single') {
        return data.length === 1
          ? { data: data[0], error: null }
          : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      }
      if (this.mode === 'maybe') {
        return data.length <= 1
          ? { data: data[0] ?? null, error: null }
          : { data: null, error: { code: 'PGRST116', message: 'multiple rows returned' } };
      }
      return { data, error: null };
    }
  }

  return {
    tables,
    from: (table: string) => ({
      select: (columns?: string) => new Query(table, 'select').select(columns),
      insert: (payload: Row | Row[]) => new Query(table, 'insert', payload),
      upsert: (payload: Row | Row[], opts?: { onConflict?: string }) => new Query(table, 'upsert', payload, opts?.onConflict),
      update: (payload: Row) => new Query(table, 'update', payload),
      delete: () => new Query(table, 'delete'),
    }),
  };
}
