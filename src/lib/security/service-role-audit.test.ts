import { describe, expect, it } from 'vitest';
import { FakeDatabase } from './fake-supabase';
import { unscopedServiceRoleQueries } from './service-role-audit';

// The audit is what turns "every service-role query carries its account
// scope" into a property `tenant-isolation.test.ts` asserts after every
// test. These cases pin down what it catches and what it lets through —
// if the audit went blind, the suite would go green while leaking.

function db(): FakeDatabase {
  return new FakeDatabase({
    contacts: [
      { id: 'c-a', account_id: 'acct-a', phone: '+1' },
      { id: 'c-b', account_id: 'acct-b', phone: '+1' },
    ],
    conversations: [{ id: 'conv-a', account_id: 'acct-a' }],
    messages: [{ id: 'msg-a', conversation_id: 'conv-a' }],
    accounts: [{ id: 'acct-a', name: 'A' }],
  });
}

describe('service-role scope audit', () => {
  it('reports a read that carries no account filter', async () => {
    const d = db();
    await d.admin.from('contacts').select('*').eq('phone', '+1');
    expect(unscopedServiceRoleQueries(d.log).map((v) => v.message)).toEqual([
      'select on contacts without account_id (filters: phone)',
    ]);
  });

  it('accepts the same read once the account filter is back', async () => {
    const d = db();
    await d.admin
      .from('contacts')
      .select('*')
      .eq('account_id', 'acct-a')
      .eq('phone', '+1');
    expect(unscopedServiceRoleQueries(d.log)).toEqual([]);
  });

  it('ignores the cookie-session client, which RLS covers', async () => {
    const d = db();
    await d
      .asUser({ userId: 'u', accountId: 'acct-a' })
      .from('contacts')
      .select('*');
    expect(unscopedServiceRoleQueries(d.log)).toEqual([]);
  });

  it('scopes a table without account_id by its parent key, not by its own id', async () => {
    const d = db();
    await d.admin.from('messages').select('*').eq('conversation_id', 'conv-a');
    expect(unscopedServiceRoleQueries(d.log)).toEqual([]);

    const other = db();
    await other.admin.from('messages').select('*').eq('id', 'msg-a');
    expect(unscopedServiceRoleQueries(other.log).map((v) => v.message)).toEqual(
      ['select on messages without conversation_id (filters: id)']
    );
  });

  it('reads `accounts` by its primary key as account-scoped', async () => {
    const d = db();
    await d.admin.from('accounts').select('*').eq('id', 'acct-a');
    expect(unscopedServiceRoleQueries(d.log)).toEqual([]);
  });

  it('judges a write by the rows it inserts, not by its filters', async () => {
    const d = db();
    await d.admin.from('contacts').insert({ phone: '+2' });
    expect(unscopedServiceRoleQueries(d.log).map((v) => v.message)).toEqual([
      'insert on contacts without account_id (rows: phone)',
    ]);

    const scoped = db();
    await scoped.admin
      .from('contacts')
      .insert({ phone: '+2', account_id: 'acct-a' });
    expect(unscopedServiceRoleQueries(scoped.log)).toEqual([]);
  });

  it('reports an update or delete that only matches on the row id', async () => {
    const d = db();
    await d.admin.from('contacts').update({ name: 'x' }).eq('id', 'c-b');
    await d.admin.from('contacts').delete().eq('id', 'c-b');
    expect(unscopedServiceRoleQueries(d.log).map((v) => v.message)).toEqual([
      'update on contacts without account_id (filters: id)',
      'delete on contacts without account_id (filters: id)',
    ]);
  });

  it('requires an account argument on an rpc call', async () => {
    const d = new FakeDatabase({}, { do_thing: () => null });
    await d.admin.rpc('do_thing', { p_conversation_id: 'conv-a' });
    expect(unscopedServiceRoleQueries(d.log).map((v) => v.message)).toEqual([
      'rpc:do_thing called with no account argument (args: p_conversation_id)',
    ]);

    const scoped = new FakeDatabase({}, { do_thing: () => null });
    await scoped.admin.rpc('do_thing', { p_account_id: 'acct-a' });
    expect(unscopedServiceRoleQueries(scoped.log)).toEqual([]);
  });

  it('silences exactly the waived query and nothing else', async () => {
    const d = db();
    await d.admin.from('contacts').select('*').eq('phone', '+1');
    await d.admin.from('contacts').update({ name: 'x' }).eq('id', 'c-b');

    const waiver = {
      table: 'contacts',
      op: 'select' as const,
      by: ['phone'],
      reason: 'test',
    };
    expect(
      unscopedServiceRoleQueries(d.log, [waiver]).map((v) => v.message)
    ).toEqual(['update on contacts without account_id (filters: id)']);

    // A waiver that names other filter columns does not apply.
    expect(
      unscopedServiceRoleQueries(d.log, [
        { ...waiver, by: ['external_id'] },
      ]).map((v) => v.message)
    ).toHaveLength(2);
  });
});
