import { randomUUID } from 'node:crypto';
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

export function createFakeDb(now = () => new Date()) {
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
    private offset = 0;
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
    range(from: number, to: number) { this.offset = from; this.max = to - from + 1; return this; }
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
        if (this.max !== null) result = result.slice(this.offset, this.offset + this.max);
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
    async rpc(name: string, p: Row) {
      const ok = (data: unknown = null) => ({ data, error: null });
      const fail = (message: string) => ({ data: null, error: { code: 'P0001', message } });
      const clock = now();
      const log = (item: Row) => rows('leaf_logs').push({ id: randomUUID(), created_at: clock.toISOString(), ...item });
      if (name === 'earn_content_leaves') {
        const u = rows('users').find((x) => x.id === p.p_user);
        const item = rows(p.p_source_type === 'post' ? 'posts' : 'comments').find((x) => x.id === p.p_source_id);
        if (!u || item?.author_id !== u.id || item.hidden || item.moderation_hidden) return ok();
        const day = String(p.p_now).slice(0, 10);
        const earned = u.earned_date === day ? u.earned_today : 0;
        const gain = Math.min(p.p_amount, 20-earned);
        if (gain > 0) {
          Object.assign(u, { leaves: u.leaves+gain, earned_today: earned+gain, earned_date: day });
          log({ user_id: u.id, type: 'earn', label: p.p_label, amount: gain, source_type: p.p_source_type, source_id: p.p_source_id });
        }
        return ok();
      }
      if (name === 'subscribe_with_leaves') {
        const u = rows('users').find((x) => x.id === p.p_user);
        if (!u || u.leaves < 10) return ok('insufficient');
        if (rows('subscriptions').some((x) => x.subscriber_id === u.id && x.author_id === p.p_author)) return ok('duplicate');
        rows('subscriptions').push({ subscriber_id: u.id, author_id: p.p_author });
        u.leaves -= 10;
        log({ user_id: u.id, type: 'spend', label: p.p_label, amount: 10 });
        return ok('ok');
      }
      if (name === 'resolve_moderation') {
        const r = rows('reports').find((x) => x.id === p.p_report);
        if (!r) return fail('신고를 찾을 수 없어요');
        const stop = p.p_action === '경고 및 게시 중단' || (p.p_action === '이용 제한' && p.p_stop);
        const item = rows(r.target_type === 'post' ? 'posts' : 'comments').find((x) => x.id === r.target_id);
        const key = r.target_type === 'post' ? 'moderation_hidden' : 'hidden';
        if (!item && (stop || p.p_action === '이용 제한')) return fail('삭제됐어요');
        const u = rows('users').find((x) => x.id === (item?.author_id ?? r.moderation_author));
        const deadline = p.p_action === '이용 제한' ? (p.p_days === 0 ? '9999-12-31T00:00:00.000Z' : new Date(+clock+p.p_days*86400000).toISOString()) : null;
        if (deadline && (!u || u.role === 'admin')) return fail('운영자 계정 또는 존재하지 않는 계정은 제한할 수 없어요');
        if (r.status === 'done' && r.action === p.p_action && !!r.moderation_stopped === !!stop && (r.moderation_days ?? null) === p.p_days && (!deadline || Date.parse(r.moderation_until) > +clock)) return ok();
        Object.assign(r, { status: 'done', action: p.p_action, moderation_author: u?.id, moderation_stopped: !!stop, moderation_until: deadline, moderation_days: p.p_days });
        const hidden = rows('reports').some((x) => x.moderation_stopped && x.target_type === r.target_type && x.target_id === r.target_id);
        let delta = 0;
        if (item && !!item[key] !== hidden) {
          item[key] = hidden;
          if (u) delta = (hidden ? -1 : 1) * rows('leaf_logs').filter((x) => x.user_id === u.id && x.type === 'earn' && x.source_type === r.target_type && x.source_id === r.target_id).reduce((n,x) => n+x.amount,0);
        }
        if (u) {
          if (delta) { u.leaves += delta; log({ user_id: u.id, type: delta < 0 ? 'spend' : 'earn', amount: Math.abs(delta), label: delta < 0 ? '게시 중단 회수' : '게시 복구 반환' }); }
          const active = rows('reports').filter((x) => x.moderation_author === u.id && Date.parse(x.moderation_until) > +clock).sort((a,b) => Date.parse(b.moderation_until)-Date.parse(a.moderation_until))[0];
          Object.assign(u, { restricted_until: active?.moderation_until ?? null, restriction_reason: active?.reason ?? null });
          rows('notifications').push({ id:randomUUID(),user_id:u.id,type:deadline?'restricted':stop?'warning':'notice',text:deadline?`${p.p_days}일`:stop?'운영자 경고 및 게시 중단':'이 신고 조치 해제',read:false,created_at:clock.toISOString() });
        }
        rows('moderation_history').push({ id:randomUUID(),report_id:r.id,action:p.p_action,stopped:stop,restriction_days:p.p_days,leaf_delta:delta,created_at:clock.toISOString() });
        return ok();
      }
      return fail(`Unknown RPC ${name}`);
    },
    from: (table: string) => ({
      select: (columns?: string) => new Query(table, 'select').select(columns),
      insert: (payload: Row | Row[]) => new Query(table, 'insert', payload),
      upsert: (payload: Row | Row[], opts?: { onConflict?: string }) => new Query(table, 'upsert', payload, opts?.onConflict),
      update: (payload: Row) => new Query(table, 'update', payload),
      delete: () => new Query(table, 'delete'),
    }),
  };
}
