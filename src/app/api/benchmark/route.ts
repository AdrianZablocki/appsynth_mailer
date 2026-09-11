import { searchBenchmark, benchmarkMedians } from '@/lib/benchmark';
import { ok, fail, guard } from '@/lib/api';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const denied = await guard(); if (denied) return denied;
  try {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return ok({ rows: searchBenchmark(q), medians: benchmarkMedians() });
  } catch (e) { return fail(e, 500); }
}
