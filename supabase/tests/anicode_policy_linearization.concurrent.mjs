import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error("TEST_DATABASE_URL must point to a disposable migrated PostgreSQL database");
}

const PSQL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function psql(applicationName, extraArgs = []) {
  return spawn(
    "psql",
    ["-X", "--no-psqlrc", "--set", "ON_ERROR_STOP=on", "--dbname", databaseUrl, ...extraArgs],
    {
      env: {
        ...process.env,
        PGAPPNAME: applicationName,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function runSql(sql, applicationName = "anicode-policy-race-control") {
  return new Promise((resolve, reject) => {
    const child = psql(applicationName, [
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`psql timed out: ${stderr || stdout}`));
    }, PSQL_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${marker}: ${errors || output}`));
    }, PSQL_TIMEOUT_MS);
    const onStdout = (chunk) => {
      output += chunk.toString();
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      cleanup();
      resolve();
    };
    const onStderr = (chunk) => {
      errors += chunk.toString();
    };
    const onClose = (code) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`psql exited before ${marker} (code ${code}): ${errors || output}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("close", onClose);
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("close", onClose);
  });
}

async function requireSuccess(result, label) {
  if (result.code !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

const suffix = randomBytes(8).toString("hex");
const holderApplication = `anicode-policy-holder-${suffix}`;
const reserveApplication = `anicode-policy-reserve-${suffix}`;
const revokeApplication = `anicode-entitlement-revoke-${suffix}`;
const entitledReserveApplication = `anicode-entitlement-reserve-${suffix}`;
const userId = randomUUID();
const requestId = randomUUID();
const entitledRequestId = randomUUID();
const deviceSubject = `d_${randomBytes(32).toString("base64url")}`;
let holder;
let originalGatewayEnabled;
let fixtureInserted = false;

try {
  const schemaCheck = await runSql(`
    select count(*)
    from pg_catalog.pg_proc as procedure
    join pg_catalog.pg_namespace as namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname in (
        'reserve_anicode_llm_request_v2',
        'reserve_anicode_llm_entitled_request_v2'
      );
  `);
  if ((await requireSuccess(schemaCheck, "migration precondition")) !== "2") {
    throw new Error("TEST_DATABASE_URL has not applied the AniCode quota/entitlement migrations");
  }

  originalGatewayEnabled = await requireSuccess(
    await runSql("select gateway_enabled::text from private.anicode_llm_policy where singleton"),
    "read policy",
  );
  if (originalGatewayEnabled !== "true" && originalGatewayEnabled !== "false") {
    throw new Error("device quota policy singleton is missing");
  }

  await requireSuccess(
    await runSql(`insert into auth.users(id) values ('${userId}')`),
    "create auth fixture",
  );
  fixtureInserted = true;
  await requireSuccess(
    await runSql(`
      update private.anicode_llm_policy
      set gateway_enabled = true,
          policy_version = policy_version + 1,
          updated_at = statement_timestamp()
      where singleton;
    `),
    "enable policy fixture",
  );

  holder = psql(holderApplication);
  holder.stdin.write(`
    begin;
    select 1 from private.anicode_llm_global_account where singleton for update;
    \\echo ANICODE_GLOBAL_LOCK_HELD
  `);
  await waitForOutput(holder, "ANICODE_GLOBAL_LOCK_HELD");

  const reservation = runSql(
    `
      set statement_timeout = '10s';
      select public.reserve_anicode_llm_request_v2(
        '${userId}', '${deviceSubject}', '${requestId}', 1, 'deepseek-v4-flash'
      );
    `,
    reserveApplication,
  );

  let observedBlockedReservation = false;
  for (let attempt = 0; attempt < PSQL_TIMEOUT_MS / POLL_INTERVAL_MS; attempt += 1) {
    const waiting = await requireSuccess(
      await runSql(`
        select count(*)
        from pg_catalog.pg_stat_activity
        where application_name = '${reserveApplication}'
          and wait_event_type = 'Lock';
      `),
      "observe blocked reservation",
    );
    if (waiting === "1") {
      observedBlockedReservation = true;
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (!observedBlockedReservation) {
    throw new Error("reservation did not block behind the global quota lock");
  }

  await requireSuccess(
    await runSql(`
      update private.anicode_llm_policy
      set gateway_enabled = false,
          policy_version = policy_version + 1,
          updated_at = statement_timestamp()
      where singleton;
    `),
    "disable policy while reservation waits",
  );

  holder.stdin.end("commit;\n\\q\n");
  const rejected = await reservation;
  if (rejected.code === 0 || !rejected.stderr.includes("gateway_disabled")) {
    throw new Error(
      `queued reservation did not observe the committed kill switch: ${
        rejected.stderr || rejected.stdout
      }`,
    );
  }
  holder = undefined;

  const ledgerRows = await requireSuccess(
    await runSql(`
      select count(*) from private.anicode_llm_requests where request_id = '${requestId}';
    `),
    "verify rejected ledger",
  );
  if (ledgerRows !== "0") {
    throw new Error("policy-rejected reservation left a request ledger row");
  }

  await requireSuccess(
    await runSql(`
      update private.anicode_llm_policy
      set gateway_enabled = true,
          policy_version = policy_version + 1,
          updated_at = statement_timestamp()
      where singleton;
      select public.grant_anicode_cloud_entitlement('${userId}');
    `),
    "prepare entitlement race",
  );

  holder = psql(revokeApplication);
  holder.stdin.write(`
    begin;
    select public.revoke_anicode_cloud_entitlement('${userId}');
    \\echo ANICODE_ENTITLEMENT_REVOKE_HELD
  `);
  await waitForOutput(holder, "ANICODE_ENTITLEMENT_REVOKE_HELD");

  const entitledReservation = runSql(
    `
      set statement_timeout = '10s';
      select public.reserve_anicode_llm_entitled_request_v2(
        '${userId}', '${deviceSubject}', '${entitledRequestId}', 1, 'deepseek-v4-flash'
      );
    `,
    entitledReserveApplication,
  );

  let observedEntitlementWait = false;
  for (let attempt = 0; attempt < PSQL_TIMEOUT_MS / POLL_INTERVAL_MS; attempt += 1) {
    const waiting = await requireSuccess(
      await runSql(`
        select count(*)
        from pg_catalog.pg_stat_activity
        where application_name = '${entitledReserveApplication}'
          and wait_event_type = 'Lock';
      `),
      "observe entitlement reservation wait",
    );
    if (waiting === "1") {
      observedEntitlementWait = true;
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (!observedEntitlementWait) {
    throw new Error("reservation did not wait for the in-flight entitlement revocation");
  }

  holder.stdin.end("commit;\n\\q\n");
  const entitlementRejected = await entitledReservation;
  if (
    entitlementRejected.code === 0 ||
    !entitlementRejected.stderr.includes("cloud_entitlement_required")
  ) {
    throw new Error(
      `reservation passed a committed entitlement revocation: ${
        entitlementRejected.stderr || entitlementRejected.stdout
      }`,
    );
  }
  holder = undefined;

  const entitlementLedgerRows = await requireSuccess(
    await runSql(`
      select count(*)
      from private.anicode_llm_requests
      where request_id = '${entitledRequestId}';
    `),
    "verify entitlement-rejected ledger",
  );
  if (entitlementLedgerRows !== "0") {
    throw new Error("entitlement-rejected reservation left a request ledger row");
  }

  console.log("policy and entitlement linearization concurrency tests passed");
} finally {
  if (holder) {
    holder.stdin.end("rollback;\n\\q\n");
    await Promise.race([
      new Promise((resolve) => holder.once("close", resolve)),
      delay(1_000).then(() => holder.kill("SIGTERM")),
    ]).catch(() => undefined);
  }
  if (originalGatewayEnabled === "true" || originalGatewayEnabled === "false") {
    await runSql(`
      update private.anicode_llm_policy
      set gateway_enabled = ${originalGatewayEnabled},
          policy_version = policy_version + 1,
          updated_at = statement_timestamp()
      where singleton;
    `).catch(() => undefined);
  }
  if (fixtureInserted) {
    await runSql(`delete from auth.users where id = '${userId}'`).catch(() => undefined);
  }
}
