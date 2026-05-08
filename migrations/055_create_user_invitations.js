/**
 * User invitations + password reset tokens — Marzam Execution Doc §6.1.
 *
 * The flow:
 *   1) Admin uploads roster CSV (or creates one user manually).
 *   2) Each new user gets a `user_invitations` row with a one-shot token.
 *   3) Email goes out with `https://app/activate/<token>`.
 *   4) User opens link → GET /api/auth/activate/:token returns email + role
 *      so the FE can show "Welcome <name>".
 *   5) User submits new password → POST /api/auth/activate/:token sets
 *      password_hash, marks `used_at`, returns a JWT for first session.
 *
 * Password resets reuse the same table with `purpose='password_reset'` so we
 * keep a single token store + retention policy rather than duplicating tables.
 *
 * Security:
 *   - Tokens are random 32-byte hex (~256 bits).
 *   - `used_at` is a hard one-shot — the activate endpoint checks it.
 *   - `expires_at` defaults to 7 days for invitations, 1 hour for resets.
 */

exports.up = async function up(knex) {
  await knex.schema.createTable('user_invitations', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('email', 320).notNullable();
    t.string('purpose', 32).notNullable().defaultTo('invitation'); // invitation|password_reset
    t.string('token', 128).notNullable().unique();
    t.string('sent_via', 16).notNullable().defaultTo('email');    // email|sms|whatsapp
    t.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    t.timestamp('sent_at');
    t.timestamp('expires_at').notNullable();
    t.timestamp('used_at');
    t.text('send_error');
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX idx_user_invitations_user
      ON user_invitations (user_id);
  `);
  await knex.raw(`
    CREATE INDEX idx_user_invitations_pending
      ON user_invitations (expires_at)
      WHERE used_at IS NULL;
  `);
  await knex.raw(`
    ALTER TABLE user_invitations
      ADD CONSTRAINT user_invitations_purpose_check
      CHECK (purpose IN ('invitation','password_reset'));
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('user_invitations');
};
