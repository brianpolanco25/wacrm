import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * El precio de un plan no vive en el código: vive en la fila de `plans`,
 * y esa fila la escriben las migraciones (041 la siembra, 059 sube
 * Inicio a 35). Lo que este archivo fija es justo eso —el catálogo
 * EFECTIVO después de aplicar las migraciones en orden— porque es lo
 * único que ni el `verify-schema.sql` puede comprobar sin una base ni la
 * UI puede equivocarse por su cuenta: `/billing` y Ajustes → Suscripción
 * pintan el número que les llega de la tabla.
 *
 * No sustituye al replay (`scripts/replay-migrations.sh`, que sí ejecuta
 * el SQL contra Postgres): lo adelanta a la compuerta, donde una
 * migración futura que vuelva a sembrar el catálogo con el precio viejo
 * falla en segundos en vez de en CI.
 */

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');

type Prices = { month: number; year: number };

/**
 * Reproduce, en el orden en que corren las migraciones, las dos formas
 * en las que este repo escribe un precio:
 *
 *   1. la lista VALUES de la semilla de la 041, `'inicio', 'Inicio', 29, 290,`;
 *   2. un `UPDATE plans SET price_usd_month = … , price_usd_year = …
 *      WHERE id = '…'`, la forma en que viaja una revisión de precios.
 *
 * Los comentarios de cabecera de cada migración mencionan precios en
 * prosa, así que ambos patrones exigen la sintaxis completa; un `-- 29`
 * suelto no cuenta.
 */
function catalogueAfterMigrations(): Map<string, Prices> {
  const prices = new Map<string, Prices>();
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
    let m: RegExpExecArray | null;

    const seeded = /\(\s*'(\w+)'\s*,\s*'[^']*'\s*,\s*(\d+)\s*,\s*(\d+)\s*,/g;
    while ((m = seeded.exec(sql))) {
      prices.set(m[1], { month: Number(m[2]), year: Number(m[3]) });
    }

    const updated =
      /UPDATE\s+(?:public\.)?plans\s+SET\s+price_usd_month\s*=\s*(\d+)\s*,\s*price_usd_year\s*=\s*(\d+)\s+WHERE\s+id\s*=\s*'(\w+)'/gi;
    while ((m = updated.exec(sql))) {
      prices.set(m[3], { month: Number(m[1]), year: Number(m[2]) });
    }
  }

  return prices;
}

describe('el catálogo de planes que dejan las migraciones', () => {
  it('cobra el plan Inicio a 35 USD/mes y 350 USD/año', () => {
    expect(catalogueAfterMigrations().get('inicio')).toEqual({
      month: 35,
      year: 350,
    });
  });

  it('cobra el plan Pro a 100 USD/mes y 1000 USD/año (065)', () => {
    expect(catalogueAfterMigrations().get('pro')).toEqual({
      month: 100,
      year: 1000,
    });
  });

  it('no mueve Negocio de 199/1990', () => {
    expect(catalogueAfterMigrations().get('negocio')).toEqual({
      month: 199,
      year: 1990,
    });
  });

  it('deja la API en Pro y Negocio, y fuera de Inicio (065)', () => {
    const revision = fs.readFileSync(
      path.join(MIGRATIONS, '065_plan_pro_100.sql'),
      'utf8'
    );

    expect(revision).toMatch(
      /SET features = array_remove\(array_remove\(features, 'api'\), 'webhooks'\)\s+WHERE id = 'inicio'/
    );
    expect(revision).toMatch(
      /array_append\(features, 'api'\)\s+WHERE id IN \('pro', 'negocio'\)/
    );
    expect(revision).not.toMatch(/provider_plan_id_(month|year)\s*=/);
  });

  it('sube el precio con una migración nueva, sin reescribir la 041', () => {
    // La 041 es la semilla que ya corrió en cualquier base existente:
    // editarla no cambiaría nada allí y dejaría la base local y la de
    // producción con precios distintos. La revisión tiene que ser un
    // archivo nuevo.
    const seed = fs.readFileSync(
      path.join(MIGRATIONS, '041_billing_model.sql'),
      'utf8'
    );
    const revision = fs.readFileSync(
      path.join(MIGRATIONS, '059_plan_inicio_35.sql'),
      'utf8'
    );

    expect(seed).toContain("'inicio', 'Inicio', 29, 290,");
    expect(revision).toMatch(/price_usd_month\s*=\s*35/);
    // Y la revisión no toca los ids de PayPal: son inmutables una vez
    // tienen suscriptores (docs/docker.md, «PayPal catalogue»).
    expect(revision).not.toMatch(/provider_plan_id_(month|year)\s*=/);
  });
});

describe('los textos de precio de la UI', () => {
  it('interpolan el importe en vez de llevarlo escrito', () => {
    // El criterio del spec es que subir el precio NO exige tocar
    // código: si una traducción escribiese «$29 / mes», la tabla diría
    // 35 y la pantalla seguiría diciendo 29.
    for (const locale of ['en', 'ko']) {
      const messages = JSON.parse(
        fs.readFileSync(
          path.join(process.cwd(), `messages/${locale}.json`),
          'utf8'
        )
      ) as { Billing: Record<string, string> };

      expect(messages.Billing.priceMonth).toContain('{price}');
      expect(messages.Billing.priceYear).toContain('{price}');
      expect(messages.Billing.priceMonth).not.toMatch(/\d/);
      expect(messages.Billing.priceYear).not.toMatch(/\d/);
    }
  });
});
