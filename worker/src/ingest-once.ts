import { Pool } from 'pg';
import { runTermsGatedIngest, type SourceSelector } from '../core/source-runner';
import type { Environment } from '../core/terms-gate';

interface Args {
  selector: SourceSelector;
  environment: Environment;
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseEnvironment(value: string | undefined): Environment {
  return value === 'production' ? 'production' : 'staging';
}

export function parseArgs(argv = process.argv.slice(2)): Args {
  const sourceId = argValue(argv, '--source-id') ?? process.env.KIDS_FUN_SOURCE_ID;
  const family = argValue(argv, '--family') ?? process.env.KIDS_FUN_SOURCE_FAMILY;
  const name = argValue(argv, '--name') ?? process.env.KIDS_FUN_SOURCE_NAME;
  const environment = parseEnvironment(
    argValue(argv, '--env') ?? process.env.KIDS_FUN_INGEST_ENV ?? process.env.APP_ENV
  );

  if (sourceId) return { selector: { id: sourceId }, environment };
  if (family && name) return { selector: { family, name }, environment };
  throw new Error('pass --source-id <uuid> or --family <family> --name <source name>');
}

async function main(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const args = parseArgs();
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await runTermsGatedIngest(pool, args.selector, args.environment);
    // JSON only; no connection strings or secrets.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
