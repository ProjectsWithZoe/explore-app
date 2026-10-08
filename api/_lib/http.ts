export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function error(status: number, message: string, headers: Record<string, string> = {}) {
  return json({ error: message }, status, headers);
}

const MAX_BODY_BYTES = 2_000_000;

export async function readJson<T = any>(request: Request): Promise<T | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
}

export function methodNotAllowed(allowed: string[]) {
  return error(405, 'Method not allowed.', { Allow: allowed.join(', ') });
}

/** Wraps a handler so unexpected failures return a JSON 500 instead of a stack trace. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return {
    async fetch(request: Request) {
      try {
        return await fn(request);
      } catch (e) {
        console.error(e);
        return error(500, 'Something went wrong. Please try again.');
      }
    },
  };
}
