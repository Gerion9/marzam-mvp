#!/usr/bin/env node
/**
 * Quick sanity check after running `npm run bq:sync prospect_scored`.
 *
 * Prints:
 *   - total prospects in pharmacies (source = 'blackprint' or 'marzam')
 *   - distribution of `quadrant`
 *   - sample of 5 rows with the new fields populated (final_score, cpadre)
 *   - rows that came from BQ but have NULL quadrant (likely an unknown
 *     value we mapped to NULL via normalizeQuadrant — worth investigating)
 *
 * Usage:
 *   node scripts/verify-prospect-scored.js
 */

require('dotenv').config();

const db = require('../src/config/database');

async function main() {
  try {
    const totals = await db.raw(`
      SELECT
        source,
        COUNT(*)::int AS n,
        COUNT(pareto)::int           AS with_pareto,
        COUNT(quadrant)::int         AS with_quadrant,
        COUNT(final_score)::int      AS with_score,
        COUNT(clave_mostrador)::int  AS with_clave_mostrador
      FROM pharmacies
      WHERE source IN ('blackprint', 'marzam')
      GROUP BY source
      ORDER BY source
    `);
    console.log('\n── pharmacies by source ───────────────────────────');
    console.table(totals.rows);

    const paretoDist = await db.raw(`
      SELECT
        pareto,
        COUNT(*)::int AS n
      FROM pharmacies
      WHERE pareto IS NOT NULL
      GROUP BY pareto
      ORDER BY pareto
    `);
    console.log('\n── PARETO distribution (Marzam clients only) ─────');
    console.table(paretoDist.rows);

    const routing = await db.raw(`
      SELECT
        source,
        CASE WHEN pareto   IS NOT NULL THEN 'pareto'   END AS has_pareto,
        CASE WHEN quadrant IS NOT NULL THEN 'quadrant' END AS has_quadrant,
        COUNT(*)::int AS n
      FROM pharmacies
      WHERE source IN ('blackprint', 'marzam')
      GROUP BY source, has_pareto, has_quadrant
      ORDER BY source, has_pareto, has_quadrant
    `);
    console.log('\n── Routing sanity check (Marzam→pareto, Blackprint→quadrant) ──');
    console.table(routing.rows);

    const distBq = await db.raw(`
      SELECT
        quadrant,
        COUNT(*)::int AS n,
        ROUND(AVG(final_score)::numeric, 1) AS avg_score,
        MIN(final_score) AS min_score,
        MAX(final_score) AS max_score
      FROM pharmacies
      WHERE quadrant IS NOT NULL
      GROUP BY quadrant
      ORDER BY quadrant
    `);
    console.log('\n── BQ.quadrant distribution (source of truth from BlackPrint) ──');
    console.table(distBq.rows);

    const distDerived = await db.raw(`
      SELECT
        quadrant_derived,
        COUNT(*)::int AS n,
        ROUND(AVG(final_score)::numeric, 1) AS avg_score,
        MIN(final_score) AS min_score,
        MAX(final_score) AS max_score
      FROM pharmacies
      WHERE quadrant_derived IS NOT NULL
      GROUP BY quadrant_derived
      ORDER BY quadrant_derived
    `);
    console.log('\n── quadrant_derived distribution (NTILE(4) over final_score, lo que ve la UI) ──');
    console.table(distDerived.rows);

    const crosstab = await db.raw(`
      SELECT
        quadrant       AS bq,
        quadrant_derived AS local,
        COUNT(*)::int  AS n
      FROM pharmacies
      WHERE quadrant IS NOT NULL AND quadrant_derived IS NOT NULL
      GROUP BY quadrant, quadrant_derived
      ORDER BY quadrant, quadrant_derived
    `);
    console.log('\n── Cross-tab BQ.quadrant × quadrant_derived (señala desalineamiento) ──');
    console.table(crosstab.rows);

    const sample = await db('pharmacies')
      .select('dataplor_id', 'name', 'source', 'pareto', 'quadrant', 'final_score', 'clave_mostrador')
      .whereNotNull('quadrant_derived')
      .orderByRaw('RANDOM()')
      .limit(5);
    console.log('\n── 5 random rows ──');
    console.table(sample);

    const linkable = await db.raw(`
      SELECT COUNT(*)::int AS marzam_clients_linkable
        FROM marzam_clients mc
        JOIN pharmacies p ON p.clave_mostrador = mc.clave_mostrador
       WHERE mc.pareto IS NOT NULL
    `);
    console.log('\n── Linkable marzam_clients ↔ pharmacies via clave_mostrador ──');
    console.table(linkable.rows);

    const orphan = await db('pharmacies')
      .count('* as n')
      .whereIn('source', ['blackprint', 'marzam'])
      .whereNull('quadrant')
      .first();
    console.log(`\n── prospects/clients without quadrant: ${orphan.n} (NULL — either pre-migration row or normalizeQuadrant rejected the source value)`);

    await db.destroy();
  } catch (e) {
    console.error('verify failed:', e.message);
    await db.destroy();
    process.exit(1);
  }
}

main();
