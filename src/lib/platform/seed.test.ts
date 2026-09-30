import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// ------------------------------------------------------------
// supabase/seed.sql (s9.7) is local lab data with public passwords.
// These tests keep it that way: nothing that points at a real project,
// no keys, and every statement safe to run twice. The SQL itself is
// run twice against the harness Postgres
// (progress/checks_unlimited-plan-and-seed.sql).
// ------------------------------------------------------------

const ROOT = process.cwd();
const SEED = fs.readFileSync(path.join(ROOT, 'supabase/seed.sql'), 'utf8');
const CODE = SEED.replace(/--[^\n]*/g, '');

/** Top-level statements, comments stripped. No `;` inside the literals. */
const STATEMENTS = CODE.split(';')
  .map((s) => s.trim())
  .filter(Boolean);

describe('supabase/seed.sql', () => {
  it('says it is local-only in its header', () => {
    const header = SEED.slice(0, 600);
    expect(header).toMatch(/SOLO DESARROLLO LOCAL/);
    expect(header).toMatch(/NUNCA contra un proyecto remoto/);
    expect(header).toMatch(/contraseñas[\s\S]*laboratorio/);
  });

  it('has no remote project URL and no key', () => {
    expect(SEED).not.toMatch(/https?:\/\//);
    expect(SEED).not.toMatch(/\.supabase\.(co|in|com)/);
    expect(SEED).not.toMatch(/service_role/i);
    expect(SEED).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(SEED).not.toMatch(/sk_(live|test)_|sb_secret_|sb_publishable_/);
  });

  it('creates the three accounts of the spec, with the lab password hashed', () => {
    for (const email of [
      'brianpolancodisenos@gmail.com',
      'brianmpolanco@gmail.com',
      'cliente.demo@example.com',
    ]) {
      expect(CODE).toContain(`'${email}'`);
    }
    expect(CODE).toMatch(
      /extensions\.crypt\('bcmp1994', extensions\.gen_salt\('bf'\)\)/
    );
    // The password appears only inside that hash call.
    expect(CODE.match(/bcmp1994/g)).toHaveLength(1);
    expect(CODE).toContain('INSERT INTO auth.identities');
    expect(CODE).toContain('INSERT INTO platform_admins');
  });

  it('is idempotent by construction', () => {
    const inserts = STATEMENTS.filter((s) => /^INSERT\s+INTO/i.test(s));
    expect(inserts.length).toBeGreaterThanOrEqual(6);
    for (const insert of inserts) {
      expect(insert).toMatch(/ON CONFLICT|NOT EXISTS/);
    }
    // No destructive or schema statements in a seed.
    for (const statement of STATEMENTS) {
      expect(statement).toMatch(/^(INSERT\s+INTO|UPDATE)\s/i);
    }
  });

  it('gives Cabbity the unlimited plan by hand and leaves the demo unpaid', () => {
    expect(CODE).toMatch(
      /'ilimitado', 'manual', 'active', NULL, NULL, NULL, NULL, NULL,\s*false/
    );
    expect(CODE).toMatch(/SET name = 'Cabbity',\s*country = 'DO'/);
    expect(CODE).toMatch(/SET name = 'Empresa Demo'/);
    expect(CODE).toMatch(/'inicio', 'incomplete'/);
  });

  it('is only run by `supabase db reset --local`, never by CI or the replay', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github/workflows/migrations.yml'),
      'utf8'
    );
    expect(workflow).toMatch(/supabase db reset --local --no-seed/);
    const config = fs.readFileSync(
      path.join(ROOT, 'supabase/config.toml'),
      'utf8'
    );
    expect(config).toMatch(
      /\[db\.seed\]\s*enabled = true\s*sql_paths = \["\.\/seed\.sql"\]/
    );
  });
});
